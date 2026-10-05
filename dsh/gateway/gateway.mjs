// MTNode agent gateway: the ONLY place in this codebase that imports dsh code.
//
// North side: a stable, mtnode-owned line-delimited JSON protocol on stdio
// (see ../DESIGN.md). South side: @deepseek-ai/dsh-sdk-client driving the
// published JSON-RPC runtime. When a dsh release breaks its SDK or wire
// format, only this file and cordis.yml change.
//
// Runs under a Node >= 22.19 executable chosen by the hosting app; it never
// runs under Electron's embedded Node.

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { getBuiltinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, statSync,
  readdirSync, lstatSync, symlinkSync, unlinkSync, cpSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
/* 思考强度档位/归一化(codex reasoning_effort_for_request 式,纯函数):
   档位词汇、路由能力表与回退链的唯一真源,gateway 与运行时 mtnode-effort 插件共用。 */
import { DEFAULT_EFFORT, effortForRoute, effortKeyOf } from './reasoning-effort.mjs'
import { normalizeHiddenTools } from './tool-visibility.mjs'
import { messagesBaseUrl } from './messages-base-url.mjs'
/* 会话自己的浏览器（用户已确认的底座：系统 Edge/Chrome + CDP 直驱 + 独立用户数据目录）。
   进程、CDP 连接、驱动串行锁、接管状态与动作留痕全在这一个模块里；网关只做两件事：
   ① 安全裁决（危险动作审批 / 接管期间拒绝）② 把帧与留痕转成宿主事件。
   零新依赖：CDP 走 Node ≥22 内置 WebSocket（见 browser-host.mjs）。 */
import * as BrowserHost from './browser-host.mjs'
/* MCP 资源只读面（宿主「扩展能力管理」里那台服务器的资源清单 / 单条读取）。
   服务器配置由宿主回传，连接缓存在网关进程里，见 mcp-resources.mjs。 */
import { handleMcpResources, closeMcpResources } from './mcp-resources.mjs'
import { dangerOfClick, APPROVE_DANGEROUS, profileDirOf, downloadDirOf, shotsDirOf } from './browser-host.mjs'

const require = createRequire(import.meta.url)
/* dsh 0.2：运行时不再由 sdk-jsonrpc-demo/bin 直起，而是 SDK 客户端按 profile 启
   `@deepseek-ai/dsh` 的 bin（内置 Node ≥ 22.19），把 cordis.yml 当作 --patch 叠加层
   应用到内置 sdk profile（base + sdk-app 两层 bundle）之上。这里只保留 cordis.yml
   的路径常量；bin 的解析交给 SDK 的 installedDshNodeLaunch（同版本校验）。
   见 dsh/DESIGN.md「运行时组合（0.2 profile + patch）」。 */
const CORDIS_PATH = path.resolve(import.meta.dirname, 'cordis.yml')
/* 运行时可执行文件（0.2）：@deepseek-ai/dsh 的 bin（lib/bin.js）。SDK 客户端自己
   也会解析同一个入口并按版本校验；这里显式传 dshBin 让它只认这一个（避免 SDK 从
   别的 node_modules 解析到另一份 dsh）。仅用于 status 回执与诊断。 */
const DSH_PKG_DIR = (() => {
  try { return path.dirname(require.resolve('@deepseek-ai/dsh/package.json')) } catch { return '' }
})()
const RUNTIME_BIN = (() => {
  if (!DSH_PKG_DIR) return ''
  try {
    const manifest = JSON.parse(readFileSync(path.join(DSH_PKG_DIR, 'package.json'), 'utf8'))
    const bin = typeof manifest.bin === 'object' && manifest.bin ? manifest.bin.dsh : manifest.bin
    return bin ? path.resolve(DSH_PKG_DIR, bin) : ''
  } catch {
    return ''
  }
})()
const GATEWAY_DIR = import.meta.dirname
const GATEWAY_VERSION = '0.1.0'
/* 池化上限：仅回收空闲 runtime。有在途 run 的永不踢掉，可短暂超过此数。 */
const MAX_RUNTIMES = 6
/* SDK 握手（initialize）超时：SDK 默认只给 10s（@deepseek-ai/dsh-sdk-client 的
   resolveDshLaunch：initializeTimeoutMs ?? 1e4）。冷起一台 runtime 要把 cordis 组合、
   设置文档、语音通道全拉起来，慢盘 / 忙机上 10s 会踩线 —— 真机就踩过：
   `RequestTimeoutError: initialize timed out after 10000ms waiting for dsh profile "sdk"`，
   而且 SDK 那次**晚到的 abort 拒绝没人接**，Node ≥15 直接判进程死（网关 exit 1，
   宿主接着报「dsh 网关已退出」，再往死管道写还带崩了主进程）。
   握手预算放宽到 60s；真超时交给 warmStartHarness 按可重试处理。 */
const INITIALIZE_TIMEOUT_MS = 60000
/* 新 spawn 运行时首轮预热超时：预热轮不是关键路径，超时即放弃、继续真实请求 */
const WARMUP_TIMEOUT_MS = 15000
/* 续跑轮 run 前的 session/resume 桥握手超时：跨进程恢复要整读盘上会话日志（可达数 MB，
   默认 zstd 还要解压），给足预算；超时按「回退旧 create 语义」处理，不阻断同进程续跑 */
const RESUME_HANDSHAKE_TIMEOUT_MS = 30000
const USER_PLUGIN_MARKER = '# ── user plugins (managed from MTNode settings) ──'

/* 两处来源同时挂载：
   - 内置：应用包 gateway/cordis.yml（运行时可选行 + ./plugins 套装）
   - 用户：配置目录 $DSH_HOME/plugins + cordis-user.yml
   挂载开关持久化在 cordis-mount.json（内置）与 cordis-user.yml（用户/MCP）。
   启动时以应用包为底合并用户段，避免升级丢掉内置行或用户包。 */
function dshHomeDir() {
  return String(process.env.DSH_HOME || '').trim()
}

function userPluginsRoot() {
  const home = dshHomeDir()
  return home ? path.join(home, 'plugins') : ''
}

function userCordisPath() {
  const home = dshHomeDir()
  return home ? path.join(home, 'cordis-user.yml') : ''
}

function mountStatePath() {
  const home = dshHomeDir()
  return home ? path.join(home, 'cordis-mount.json') : ''
}

function pkgRootName(name) {
  const n = String(name || '').trim()
  if (!n || /^\.\.?[/\\]/.test(n) || /^[A-Za-z]:[\\/]/.test(n) || n.startsWith('/')) return ''
  return n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0]
}

function ensureUserPluginsPkg() {
  const root = userPluginsRoot()
  if (!root) return ''
  mkdirSync(root, { recursive: true })
  const pj = path.join(root, 'package.json')
  if (!existsSync(pj)) {
    writeFileSync(pj, JSON.stringify({
      name: 'mtnode-dsh-user-plugins',
      private: true,
      version: '1.0.0',
      dependencies: {},
    }, null, 2) + '\n', 'utf8')
  }
  return root
}

function pluginNameFromBlock(block) {
  const m = String(block || '').match(/^\s*name:\s*'([^']+)'/m)
  return m ? m[1] : ''
}

function isUserOwnedBlock(block) {
  const name = pluginNameFromBlock(block)
  if (!name) return false
  if (isBundledPluginName(name)) return false
  return true
}

function rowsToYaml(rows) {
  return (rows || []).map((r) => {
    const c = (r.comments || []).map((x) => '# ' + x).join('\n')
    return (c ? c + '\n' : '') + r.block
  }).filter(Boolean).join('\n\n')
}

function persistUserOwnedRows() {
  const dest = userCordisPath()
  if (!dest) return
  try {
    const { userPart } = readRows()
    mkdirSync(path.dirname(dest), { recursive: true })
    const owned = parsePluginRows(userPart).filter((r) => isUserOwnedBlock(r.block))
    const body = rowsToYaml(owned)
    writeFileSync(dest, (body ? body + '\n' : ''), 'utf8')
  } catch { /* best-effort */ }
}

function persistBuiltinMounts() {
  const dest = mountStatePath()
  if (!dest) return
  try {
    const disabled = []
    for (const p of listPlugins()) {
      if (!p.toggleable || !p.disabled) continue
      if (p.kind === 'runtime' || isBundledPluginName(p.name)) disabled.push(p.id)
    }
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify({ disabled }, null, 2) + '\n', 'utf8')
  } catch { /* best-effort */ }
}

function persistUserSection() {
  persistUserOwnedRows()
  persistBuiltinMounts()
}

function readPersistedUserRows() {
  const dest = userCordisPath()
  if (!dest || !existsSync(dest)) return []
  try {
    return parsePluginRows(USER_PLUGIN_MARKER + '\n' + readFileSync(dest, 'utf8'))
      .filter((r) => isUserOwnedBlock(r.block))
  } catch {
    return []
  }
}

function readMountDisabledIds() {
  const dest = mountStatePath()
  if (!dest || !existsSync(dest)) return []
  try {
    const j = JSON.parse(readFileSync(dest, 'utf8'))
    return Array.isArray(j.disabled) ? j.disabled.map(String) : []
  } catch {
    return []
  }
}

function setBlockDisabled(block, enabled) {
  if (/^\s*disabled:\s*!!js\b/m.test(block)) return block
  if (enabled) return block.replace(/^\s*disabled:\s*true\s*\n/m, '')
  if (/^\s*disabled:\s*true\s*$/m.test(block)) return block
  return block.replace(/^(  name: '[^']+'\n)/m, "$1  disabled: true\n")
}

function applyBuiltinMounts(disabledIds) {
  const want = new Set((disabledIds || []).map(String))
  if (!want.size && !disabledIds) return
  rewritePluginBlocks((block) => {
    const idm = block.match(/^- id:\s*(\S+)/)
    const namem = block.match(/^\s*name:\s*'([^']+)'/m)
    if (!idm) return block
    const id = idm[1]
    const name = namem ? namem[1] : ''
    const builtin = OPTIONAL_RUNTIME_IDS.has(id) || isBundledPluginName(name)
    if (!builtin) return block
    return setBlockDisabled(block, !want.has(id))
  }, { persist: false })
}

/* 出厂默认关闭的可挂载内置行（组合里静态 disabled: true）。
   升级保底：mountState 早于该默认时，启动后也保持关闭，
   避免 applyBuiltinMounts 把它们重新挂起。 */
function shipDisabledIds() {
  const { shipped, userPart } = readRows()
  const out = []
  for (const row of parsePluginRows(shipped)) {
    const p = describePlugin(row.block, 'runtime', row)
    if (p && p.toggleable && p.disabled && p.id) out.push(p.id)
  }
  for (const row of parsePluginRows(userPart)) {
    const p = describePlugin(row.block, 'user', row)
    if (p && p.toggleable && p.disabled && p.id && isBundledPluginName(p.name)) out.push(p.id)
  }
  return [...new Set(out)]
}

function migratePkgFromGateway(pkgName) {
  const root = ensureUserPluginsPkg()
  const key = pkgRootName(pkgName)
  if (!root || !key) return
  const dest = path.join(root, 'node_modules', key)
  const src = path.join(GATEWAY_DIR, 'node_modules', key)
  if (existsSync(dest) || !existsSync(src)) return
  try {
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true })
    const pj = path.join(root, 'package.json')
    const json = JSON.parse(readFileSync(pj, 'utf8'))
    if (!json.dependencies) json.dependencies = {}
    if (!json.dependencies[key]) {
      let ver = '*'
      try {
        ver = String(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).version || '*')
      } catch { /* keep * */ }
      json.dependencies[key] = ver.startsWith('^') || ver.startsWith('~') ? ver : ver
      writeFileSync(pj, JSON.stringify(json, null, 2) + '\n', 'utf8')
    }
  } catch { /* best-effort migrate */ }
}

function linkOneUserPkg(src, dst) {
  try {
    if (existsSync(dst)) {
      const st = lstatSync(dst)
      if (st.isSymbolicLink()) return
      /* 网关自带真实包：不覆盖 */
      return
    }
    mkdirSync(path.dirname(dst), { recursive: true })
    try {
      const type = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(src, dst, type)
      return
    } catch {
      /* 跨盘 junction 会失败：退化为复制，升级后下次启动再从 DSH_HOME 补回 */
      cpSync(src, dst, { recursive: true })
    }
  } catch { /* skip link/copy failures */ }
}

function linkUserPackagesIntoGateway() {
  const root = userPluginsRoot()
  if (!root) return
  const srcNm = path.join(root, 'node_modules')
  const dstNm = path.join(GATEWAY_DIR, 'node_modules')
  if (!existsSync(srcNm)) return
  mkdirSync(dstNm, { recursive: true })
  for (const ent of readdirSync(srcNm, { withFileTypes: true })) {
    if (ent.name === '.bin' || ent.name.startsWith('.')) continue
    const src = path.join(srcNm, ent.name)
    if (ent.name.startsWith('@')) {
      let kids = []
      try { kids = readdirSync(src) } catch { continue }
      for (const pkg of kids) {
        if (pkg.startsWith('.')) continue
        linkOneUserPkg(path.join(src, pkg), path.join(dstNm, ent.name, pkg))
      }
    } else if (ent.isDirectory() || ent.isSymbolicLink()) {
      linkOneUserPkg(src, path.join(dstNm, ent.name))
    }
  }
}

function syncUserPluginsFromHome() {
  const dest = userCordisPath()
  if (!dest || !existsSync(CORDIS_PATH)) return
  const { shipped, userPart, marker } = readRows()
  const appRows = parsePluginRows(userPart)
  const bundledRows = appRows.filter((r) => !isUserOwnedBlock(r.block))
  const currentOwned = appRows.filter((r) => isUserOwnedBlock(r.block))

  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true })
    const body = rowsToYaml(currentOwned)
    writeFileSync(dest, (body ? body + '\n' : ''), 'utf8')
    for (const row of currentOwned) migratePkgFromGateway(pluginNameFromBlock(row.block))
  }

  const persistedOwned = readPersistedUserRows()
  /* 旧版 cordis-user.yml 可能混入了内置 ./plugins 行：只保留用户包/MCP */
  const ownedMap = new Map()
  for (const r of currentOwned) {
    const k = pluginNameFromBlock(r.block) || r.id
    if (k) ownedMap.set(k, r)
  }
  for (const r of persistedOwned) {
    const k = pluginNameFromBlock(r.block) || r.id
    if (k) ownedMap.set(k, r)
  }
  const mergedOwned = Array.from(ownedMap.values())
  const ownedYaml = rowsToYaml(mergedOwned)
  if (ownedYaml !== rowsToYaml(persistedOwned)) {
    writeFileSync(dest, (ownedYaml ? ownedYaml + '\n' : ''), 'utf8')
  }
  const bundledYaml = rowsToYaml(bundledRows)
  const next = shipped
    + marker
    + (bundledYaml ? '\n' + bundledYaml + '\n' : '\n')
    + (ownedYaml ? '\n' + ownedYaml + '\n' : '')
  if (next !== readFileSync(CORDIS_PATH, 'utf8')) {
    writeFileSync(CORDIS_PATH, next.endsWith('\n') ? next : next + '\n', 'utf8')
  }

  let disabledIds = readMountDisabledIds()
  if (!disabledIds.length && !existsSync(mountStatePath())) {
    disabledIds = listPlugins()
      .filter((p) => p.toggleable && p.disabled && (p.kind === 'runtime' || isBundledPluginName(p.name)))
      .map((p) => p.id)
    const mp = mountStatePath()
    if (mp && disabledIds.length) {
      mkdirSync(path.dirname(mp), { recursive: true })
      writeFileSync(mp, JSON.stringify({ disabled: disabledIds }, null, 2) + '\n', 'utf8')
    }
  }
  /* 升级保底：出厂默认关闭的内置行（如 router-standard）在 mountState
     早于该默认时也保持关闭，避免 applyBuiltinMounts 把它重新挂起。 */
  const extra = shipDisabledIds().filter((id) => !disabledIds.includes(id))
  if (extra.length) {
    disabledIds = disabledIds.concat(extra)
    const mp = mountStatePath()
    if (mp) {
      try {
        mkdirSync(path.dirname(mp), { recursive: true })
        writeFileSync(mp, JSON.stringify({ disabled: disabledIds }, null, 2) + '\n', 'utf8')
      } catch { /* best-effort */ }
    }
  }
  if (disabledIds.length) applyBuiltinMounts(disabledIds)

  for (const row of mergedOwned) migratePkgFromGateway(pluginNameFromBlock(row.block))
  ensureUserPluginsPkg()
  linkUserPackagesIntoGateway()
}

/* Node ESM cannot import a directory. Local plugin rows must name a file
   (package.json "main" / index.js). Rewrite in place so an old
   `./plugins/foo` row still boots after pack. */
function toCordisRel(absFile) {
  let rel = path.relative(GATEWAY_DIR, absFile).replace(/\\/g, '/')
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
}

function resolveLocalPluginEntry(name) {
  const n = String(name || '').trim()
  if (!/^\.\.?[/\\]/.test(n)) return n
  const abs = path.resolve(GATEWAY_DIR, n)
  try {
    if (!statSync(abs).isDirectory()) return n.replace(/\\/g, '/')
  } catch {
    return n
  }
  if (existsSync(path.join(abs, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(abs, 'package.json'), 'utf8'))
      const exp = pkg.exports && pkg.exports['.']
      const main = (typeof exp === 'string' ? exp : exp && exp.default) || pkg.main
      if (typeof main === 'string') {
        const file = path.resolve(abs, main)
        if (existsSync(file) && statSync(file).isFile()) return toCordisRel(file)
      }
    } catch { /* fall through to index candidates */ }
  }
  for (const cand of ['index.js', 'index.mjs', 'lib/index.js', 'lib/index.mjs']) {
    const file = path.join(abs, cand)
    if (existsSync(file) && statSync(file).isFile()) return toCordisRel(file)
  }
  return n
}

function ensureFilePluginEntries() {
  if (!existsSync(CORDIS_PATH)) return
  const text = readFileSync(CORDIS_PATH, 'utf8')
  const next = text.replace(/^(\s*name:\s*')([^']+)(')/gm, (full, a, name, b) => {
    const resolved = resolveLocalPluginEntry(name)
    return resolved === name ? full : a + resolved + b
  })
  if (next !== text) writeFileSync(CORDIS_PATH, next, 'utf8')
}

/* 用户插件同步在 readRows / parsePluginRows 定义之后执行（见下方 initUserPlugins）。 */

/* Agent 预设(迁移自 dsh 的 agent-presets 概念):作为每次运行的角色前缀,
   由宿主应用在设置中选择,随 run 参数下发。预设只约束角色与思考的表达形式,
   不碰思考强度:reasoningEffort 一律沿用宿主下发的设置(档位真源见
   reasoning-effort.mjs 与下方「思考强度」注释 —— lean(思维精简)历史上会把
   「标准」压到 low,现已取消,压 token 只靠提示词的骨架纪律)。
   历史 id 兼容见 LEGACY_PRESET_IDS:旧会话/智能节点存的 'sketch' 归一到 'lean'。
   本表的**键序不决定界面顺序** —— 界面档位表与默认档的唯一真源在渲染层
   renderer/app.js 的 AGENT_PRESETS / AGENT_PRESET_DEFAULT(默认档现为 minimal 极简,
   排第一;standard 第二;lean 第三)。未知或缺省的 preset 一律回落到 PRESETS.standard。
   standard 本轮去过重(降 Token 固定开销):它过去把画布字段、端子口径、开发节点规范、
   批次与排版细则整段抄一遍(6976 字符,每一步都随历史重发),那是同一规则的第三 / 第四份
   拷贝。现只留「人设 + 行为纪律 + 指向真源」(约 2K 字符)——参数机制的真源 = mtnode_canvas_*
   工具描述与参数表,完整规范的真源 = 内置技能,分工表见 docs/prompt-source-of-truth.md。
   它仍是兜底档:人设与「先读工具描述 / 先加载技能」的动作都在,不会让模型不知道自己能干什么。 */
const PRESETS = {
  standard:
    'You are the agent engine inside MTNode, a visual AI-workflow desktop app: a node canvas ordinary users build and re-run. Finish concrete content and file tasks — read and write files, search the web, run commands when needed, and edit the canvas with mtnode_canvas_get / mtnode_canvas_edit / mtnode_app. Division of labour: field names, enums, port numbering and @-reference syntax are documented in the descriptions of those tools themselves — that is their only source, so read the tool description instead of guessing, and call mtnode_canvas_get before editing. Read the canvas cheaply: detail "minimal" (the default) gives a node index only; add ids / sections / bodyLimit and ask for detail "standard" for config fields, or detail:"full" only when you truly need complete bodies or rows. For any canvas discipline, load the matching built-in skill with the skill tool and follow it: mtnode-dev-architect (dev nodes / project module blocks), mtnode-canvas-edit-rules (the full canvas-editing hard rules: task/super/ports/@-refs/save-wait_file/batch/media — mtnode_canvas_edit keeps only the gist), mtnode-canvas-batch-safety (batch runs + text-to-image), mtnode-canvas-layout-ux (marks, zones, control nodes, tidying a layout), mtnode-media-gen-nodes (music / speech / video backends), mtnode-db-facts (a wired database replica), mtnode-ai-facts (the canvas AI fact library: query it before indexing project content, and record the key conclusions after building architecture / workflows), mtnode-grill-me (ask the whole frontier before building). Behaviour that stays yours: keep text processing separate from image→text — a vision or agent node turns pixels into text, then pure-text nodes consume that text so language steps can use a better model; use mtnode_vision for mid-task pixel reading instead of stuffing images into the prompt; when the user asks for a workflow, build an editable left-to-right pipeline they can re-run with a control ▶ node rather than doing everything yourself; for anything beyond a handful of nodes plan with kind "task" nodes first instead of dumping a mixed graph; when you write the prompt/task of a node and it must use the content of another node, reference it as @Title instead of pasting the body of that node inline (a material/asset node is referenced by its entry title, never by its own node title — syntax and the global-broadcast conditions are in the mtnode_canvas_edit description); treat tool receipts (created / updated / warnings) as the only proof of what happened — never invent node titles or claim results that are not in the receipt. Keep long bodies out of the main context: never paste an upstream node body into a prompt/task (write @Title instead), have an agent_task or input_text node write long copy or instructions to a file and report only the path, and describe the shape of a finished text instead of pasting it as an example while building a graph. Keep your closing report tight: what you changed, the artifact paths, and the 1–2 things the user must do — do not restate the whole canvas. Isolate long multi-round work (build → self-check → layout) in a subagent context and take back only the final receipt. Then work step by step, say what you are doing, and end with a clear, complete result.',
  minimal:
    'You are a direct executor. Finish the task with minimal steps and minimal talk; reply only with what matters, and end with the result itself.',
  code:
    'You are a software engineer. Inspect files before editing, write or modify code and run commands to finish the task, and report what you changed and how to verify it.',
  cordis:
    'You are a Cordis plugin developer for DeepSeek Harness. Follow Cordis conventions (Service classes, ctx.effect/ctx.on registrations, typed events) when writing plugins or composition files.',
  /* 思维精简(压缩思考表达,原名草图模式 sketch):四法融合 —— Structured CoT(GBNF 强制 GOAL/APPROACH/EDGE 骨架,此处以硬格式替代约束解码)·
     Sketch-of-Thought(概念链/符号化草图)· CRISP(注意力剪枝的提示级等价:凡不改变下一步决策的推理句一律删)·
     Focused CoT(先一行结构化输入再推理)。文本已压成单段:去掉方法标号(①②③④)与整段「本档不改变工具授权」声明
     —— 授权只由运行时【Agent 工具许可】段决定,app-db.js 的 nodeLock 决议不读本文本,无需再花 token 自证;
     只留一句身份(自称 Lean Thinking mode,与界面档位名对应)。真复杂任务仍允许破例展开一次深推理再压缩回骨架。
     本档不声明任何思考上限:思考强度按用户在界面上的选择走(标准 / 最强)。 */
  lean:
    'You are the agent engine inside MTNode in Lean Thinking mode. Follow the reasoning rules: before acting, compress the input into ONE line: GOAL/GIVEN/DECIDE; think only inside this fixed skeleton: GOAL(one line) / APPROACH(≤3 symbolic steps, one line each) / EDGE(one line) / DO(concrete next action); no added or removed sections, never restate user wording or tool output; use symbols and arrows (A→B, {candidate}/✔, one line of pseudocode per step), never flowing prose; drop any sentence that does not change the next decision; consult the source (read/grep/query) for unknowns. For complex tasks, you may break the skeleton ONCE and expand a deep reasoning pass, then compress again. End every turn with a clear, complete result.',
  /* 画布智能节点:办事但不改图。由宿主在 node 运行时把「默认档」换成此档(见 app-db.js 的
     preset 决议:standard 与 AGENT_PRESET_DEFAULT 都映射到 node),不出现在 UI 预设列表。 */
  node:
    'You are the agent engine inside MTNode, running as a canvas AGENT NODE (kind agent_task, or proc_text with agent:true). Finish the task in front of you: read and write files, search the web, run commands when needed. You MUST NOT edit the canvas or create nodes / wires / marks — do not call mtnode_canvas_get, mtnode_canvas_edit or mtnode_app — this run does not even register them (the host would reject every call anyway). Deliver results by writing files, so later nodes can read the agreed paths. Use mtnode_vision with an absolute imagePath when you must read pixels. If this run injects a database note, obey it: facts, citations and number math come from the mtnode_db tool, never from memory. Work step by step, show the user what you are doing, and end with a clear, complete result.',
  /* 桌宠对话:不走 MTNode 画布/文件助手人设,身份由 hostPersona 覆盖 system-prompt */
  bongochat: '',
  /* 会话「纯净模式」(renderer 会话输入区按钮开启):不注入任何角色前缀,
     配合宿主清空的 systemPrompt,模型输入 = 纯粹的用户消息 */
  pure: '',
}

/* 预设旧 id 兼容:渲染层档位改名(草图模式 → 思维精简 sketch → lean)后,历史会话、
   智能节点与持久化设置里仍可能存着旧值。这里在网关入口统一归一,避免旧 id 静默
   回落到 standard(预设文本会整个丢失,骨架纪律不生效、token 白白多烧)。 */
const LEGACY_PRESET_IDS = { sketch: 'lean' }

/** 把宿主下发的预设 id 归一为 PRESETS 的现名 */
function normalizePresetId(preset) {
  const raw = String(preset ?? '').trim()
  return Object.prototype.hasOwnProperty.call(LEGACY_PRESET_IDS, raw) ? LEGACY_PRESET_IDS[raw] : raw
}

/* 按运行裁剪可见工具集（名单通道）：宿主每轮算出「这一轮根本不该存在的工具名」随 run
   参数 hideTools 下发，网关归一（只认 tool-visibility.mjs 白名单里的名字、去重、排序）后
   写进 spawn env MTNODE_HIDE_TOOLS，并把指纹打进 runtime key。
   与下面两个标记的分工：lean / noCanvas 是「整档」裁剪（两个布尔，注册口直接跳过），
   hideTools 是「按名字」裁剪 —— 未接入数据库副本时剔 mtnode_db、Agent 工具许可预设里
   被拒到点上的工具、以及引擎自带的 goal / 子代理 / 后台任务档，都走这条名单。
   名单里的 MTNode 自有工具在各自插件的注册口就不注册；引擎自带的工具改不到注册，
   由 mtnode-tool-visibility 插件在每个 agent 创建时 ctx.tools.restrict({deny}) 摘除。
   三条通道都进 runtime key，所以一台运行时从生到死只有一个可见集形状（轮内绝不变形，
   否则提示缓存从变化的那个 schema 起整段失效 —— 省字符反而赔缓存）。 */
const HIDE_TOOLS_ENV = 'MTNODE_HIDE_TOOLS'

/* 精简工具负载的下达说明：本轮真的裁掉了工具时，才拼到预设文本后面一句。
   为什么需要这句：被裁的工具是整个不注册（模型看不见），但人设与技能里还写着
   「用 mtnode_app 改画布名 / 用 mtnode_vision 识图」——不补一句就会去撞不存在的
   工具，把轮次浪费在报错上。一句 ≈ 90 字符，换掉的是每次模型调用重发的 4.9K 字符
   工具定义（实测 mtnode_app 3,262 + mtnode_vision 1,629）。
   nodeLock（noCanvas）不在此列：那条链上「不得调用画布工具」的行为纪律已经有唯一
   真源（PRESETS.node + 渲染层 node_capability 节），不再抄第三份。 */
const LEAN_TOOLS_NOTE =
  '\n\n【精简工具负载】本轮未注册 mtnode_app 与 mtnode_vision：这两个工具不存在，调用即失败。' +
  '改画布仍用 mtnode_canvas_get / mtnode_canvas_edit；需要看图片内容就换用文件读取，不要尝试识图。'

/** @type {Map<string, {harness: Promise<DeepSeekHarness>, order: number}>} */
const runtimes = new Map()
let runtimeOrder = 0

/* ── interaction bridge (mtnode-bridge / mtnode-canvas ↔ renderer) ─────── */
/** @type {Map<string, {server: import('node:net').Server, sockets: Set<any>}>} */
const bridgeServers = new Map()
const socketToKey = new Map()
/* ── 语音通道（mtnode-speech ↔ 渲染层录音界面）────────────────────────────
   与交互桥共用同一只回环 TCP 服务，靠首帧 {t:'speech-hello', token} 区分。这条通道
   **不受轮次归属门控**：录音是用户此刻想说话时发起的，与任何一轮都无关。 */
/** runtime key -> {port, token}（该台运行时的语音通道凭据） */
const speechRuntimes = new Map()
/** runtime key -> 该台运行时当前连着的语音 socket（一台一个） */
const speechSockets = new Map()
/** socket -> runtime key（收回时按它清理） */
const speechSocketKey = new Map()
/** 请求 id -> {key, resolve, reject}（网关发起的 state / prepare / transcribe 等） */
const speechPending = new Map()
/** @type {Map<string, {socket: any, key: string, kind: string, reqId: string, sessionId: string}>} */
const bridgePending = new Map()
/** 在途占用表:runtime key -> {reqId, sessionId, sessions}。一台 runtime 同时只允许一个在途 run。
    sessionId = 本轮「真实轮」在运行时里的 dsh session id(网关铸造并显式传给 harness.run);
    sessions = 本轮通知流里见到过的全部 session id 集合(真实轮 + 它自己派生的子代理/后台 job)。
    交互桥帧自带发起方的 sessionId,网关据此判定「这帧属不属于此刻在跑的这一轮」——
    预热轮('ok')、上一轮遗留的后台 job / 子代理拿的都是别的 session,在此归零。 */
const keyToReqId = new Map()
/* 上一轮的归属快照(只为日志分类,绝不参与放行):runtime key -> 那一轮见过的全部 session
   (真实轮 + 它派生的子代理/后台 job + 它的预热轮)。轮次结束或易主时写入,runtime 关闭即清。
   有了它,越权帧才能分清三种来路:本轮预热轮在问话 / 上一轮遗留的后台 job 现在才醒 /
   完全来路不明。整表上限 64 台,超出丢最早登记的。 */
const PRIOR_SESSIONS_KEYS = 64
/** @type {Map<string, Set<string>>} */
const priorRunSessions = new Map()

/* 诊断出口:stdout 是本进程的协议信道,不能掺杂东西;stderr 由主进程落日志
   (dsh/main-dsh.js 把 gateway stderr 逐行写进日志),越权提问必须留下痕迹。 */
function diag(line) {
  try { process.stderr.write('[ix-gate] ' + line + '\n') } catch {}
}

/* 未处理拒绝的「窄护栏」——只放行 SDK 晚到的那类握手超时，别的照旧让进程死。
   来由：SDK 客户端的 request() 用 AbortController 计时，超时那一枪 abort(reason) 会在
   调用方已经收尾之后才把拒绝派发出来（@deepseek-ai/dsh-sdk-client lib/index.js 的
   request()/initialize()），Node ≥15 的默认行为就是「未处理拒绝 = 致命错误」→
   整只网关进程 exit 1，宿主那一轮只能拿到「dsh 网关已退出」。真机 2026-10-03 07:42
   那次崩溃就是这条链（网关死 → 主进程往死管道写 EPIPE）。
   判据收得很紧：只认 SDK 的 RequestTimeoutError / 那句 initialize 超时文案；
   其它未处理拒绝 rethrow（= 保持 Node 默认的致命语义，真 bug 不许被吞掉）。 */
const SDK_LATE_ABORT = /RequestTimeoutError|timed out after \d+ms waiting for dsh profile/
process.on('unhandledRejection', (reason) => {
  const name = (reason && reason.name) || ''
  const msg = (reason && reason.message) || String(reason || '')
  if (name === 'RequestTimeoutError' || SDK_LATE_ABORT.test(msg)) {
    diag('已忽略 SDK 晚到的握手超时拒绝（网关保持存活）：' + msg.slice(0, 300))
    return
  }
  throw reason
})

/* runtime key 里含绝对路径,日志只留足够定位的尾巴 */
function shortKey(key) {
  const s = String(key || '')
  return s.length > 72 ? '…' + s.slice(-72) : s
}

/* ── 失败轮 runtime「续跑候选」保活 ──────────────────────────────────────
   一轮 run 以可重发错误(429 / 5xx / 网络)结束时,宿主(renderer app-db.js
   dshRunTask)会在 ~5s 重发窗口内带 resumeSession 点名续跑同一会话。续跑要真续上,
   失败轮那台 runtime 进程必须还活着:
     · 同进程点名 → SDK server 进程内命中该会话 → 直接在中断处继续,已写内容不重烧;
     · 进程没了(LRU 换出 / 被关)→ 新进程以「新会话 + 续跑指令」去碰盘上旧日志,
       dsh-session-persistence 判前缀不符 → id collision → RESUME_UNAVAILABLE →
       退回整轮重发,前功尽弃白烧一遍。
   因此在失败轮收尾(handleRun finally,解除占用后)给该 runtime 打「续跑候选」标记,
   带 ~60s 时限与失败轮 reqId:
   - LRU 淘汰(getRuntime 超池回收)与 closeRuntimeByKey 对候选豁免 —— 重发窗口内
     不被换出 / 关掉;
   - 时限到,或候选被新一轮正常占用(claimRuntime 登记新 reqId)后自动清除,防泄漏;
   - 用户取消路径不受影响:cancelRuntime / closeAllRuntimes 关进程前先摘候选标记
     (cancel = 用户明确不要这轮了,保活窗口作废);带 tag 的在途取消只命中占用中的
     runtime(候选必然空闲),同样不受阻。
   与 keyToReqId 占用表的关系:候选标记只作用于「无在途轮」的空闲 runtime(有 claim
   的本就被 keyToReqId 保护,LRU 从不碰);标记不进占用表、不改变复用判据 ——
   重发轮照旧经 pickRuntimeKey 拿到同一台 baseKey 进程。 */
const RESUME_CANDIDATE_TTL_MS = 60000
/** @type {Map<string, {reqId: string, until: number}>} runtime key -> 续跑候选 */
const resumeCandidates = new Map()

/* 清掉过期候选。懒扫描即可:候选数 ≤ 池内 idle runtime,无需定时器 */
function sweepResumeCandidates() {
  if (!resumeCandidates.size) return
  const now = Date.now()
  for (const [k, c] of Array.from(resumeCandidates)) {
    if (now >= c.until) resumeCandidates.delete(k)
  }
}

/* 这台 runtime 是否仍在保活窗口内;过期即清除并视为非候选 */
function resumeCandidateOf(key) {
  if (!key) return null
  const c = resumeCandidates.get(key)
  if (!c) return null
  if (Date.now() >= c.until) {
    resumeCandidates.delete(key)
    return null
  }
  return c
}

function clearResumeCandidate(key) {
  if (key != null) resumeCandidates.delete(key)
}

/* 打「续跑候选」标记:仅当失败报文属宿主会自动重发的类别,且这台 runtime 确实还
   活着(被取消 / 崩溃关掉的无从保活)。同一台再次失败(重发轮又撞 429)时刷新时限,
   整条 5s/5s 重发链都被覆盖。 */
function markResumeCandidate(key, reqId, message) {
  if (!key || !runtimes.has(key) || keyToReqId.has(key)) return
  if (!isRetryableGatewayFailure(String(message || ''))) return
  const now = Date.now()
  const c = resumeCandidates.get(key)
  if (c) {
    c.until = now + RESUME_CANDIDATE_TTL_MS
    if (reqId) c.reqId = String(reqId)
  } else {
    resumeCandidates.set(key, { reqId: String(reqId || ''), until: now + RESUME_CANDIDATE_TTL_MS })
  }
  diag(
    `resume-candidate key=${shortKey(key)} reqId=${reqId || '(无)'} ` +
    `ttl=${RESUME_CANDIDATE_TTL_MS}ms err=${String(message || '').slice(0, 120)}`,
  )
}

/* 失败报文是否属宿主会自动重发的类别(429 / 限流 / 5xx / 网络 / 传输 / 上游)。
   网关侧只做「要不要保活这台进程」的判定,与宿主 dshRunRetryable 判据同族但更收:
   取消 / 配置类错误宿主不会重发,保活窗口只会白占进程,一律不标。 */
const RETRYABLE_FAILURE_RE =
  /(^|\D)429(\D|$)|rate\s*limit|too many requests|insufficient_quota|quota|(^|\D)5\d\d(\D|$)|econn|socket hang up|fetch failed|getaddrinfo|network error|request timed out|timed ?out|runtime is not running|transport closed|bad gateway|service unavailable|temporar|upstream|服务器繁忙|服务暂|稍后重试|请求过于频繁|限流|过载|上游/i

function isRetryableGatewayFailure(message) {
  const s = String(message || '').trim()
  if (!s) return false
  /* 宿主不会自动重发的失败:取消 / 终止、配置类、会话不可续跑 —— 不保活 */
  if (
    /中止|取消|cancel|abort|aborted|已终止|已手动停止|已请求终止|已请求中断|resume_unavailable|未配置|api ?key|任务内容为空|工作范围为/i.test(s)
  ) {
    return false
  }
  return RETRYABLE_FAILURE_RE.test(s)
}

/* cancelTag(会话 agent:<id> / 节点 id / assist)-> 该标签在途运行占用的 runtime key 集合。
   dsh 线协议没有「逐轮取消」,停一次运行只能关掉它自己那台 runtime 进程;
   若没有这层映射,cancel 只能退化成「按 workspace 全关」——同工作目录的其它会话
   会被一起打断(就是「停一个会话导致所有会话中断」的根因)。
   同一标签可能并发跑好几台(如某节点批量并行的视觉描述),所以值是集合。 */
const tagToKey = new Map()
/* 早到一步的取消:用户在这轮 run 还没跑到 getRuntime(设置热重载 + 引擎 spawn 要 1~3s)
   时就按了 ■。记下标签,等它真拿到 runtime 立刻关掉,否则这轮会白跑到底。
   只对本轮确实还在途的 tag 生效(activeRunTags),免得给下一轮误埋取消。 */
const cancelWanted = new Map()
const activeRunTags = new Set()
const CANCEL_WANTED_TTL_MS = 120000

function wantCancelTag(tag) {
  cancelWanted.set(tag, Date.now())
  for (const [t, at] of Array.from(cancelWanted)) {
    if (Date.now() - at > CANCEL_WANTED_TTL_MS) cancelWanted.delete(t)
  }
}

function takeCancelWanted(tag) {
  if (!tag || !cancelWanted.has(tag)) return false
  cancelWanted.delete(tag)
  return true
}

function tagOf(cancelTag) {
  return cancelTag == null ? '' : String(cancelTag)
}

function forgetKey(k) {
  if (k == null) {
    tagToKey.clear()
    priorRunSessions.clear()
    return
  }
  priorRunSessions.delete(k)
  for (const [t, set] of Array.from(tagToKey)) {
    set.delete(k)
    if (!set.size) tagToKey.delete(t)
  }
}

/* 把一轮的归属快照成「上一轮」,供越权帧分类(warm / stale)用。
   只在轮次结束或易主时调用,放行判据永远只看当前 claim.sessions —— 快照不开任何口子。 */
function snapshotPriorSessions(key, c) {
  if (!key || !c) return
  const set = new Set(c.sessions || [])
  if (c.warmSession) set.add(c.warmSession)
  if (!set.size) {
    priorRunSessions.delete(key)
    return
  }
  priorRunSessions.set(key, set)
  if (priorRunSessions.size > PRIOR_SESSIONS_KEYS) {
    for (const k of priorRunSessions.keys()) {
      if (priorRunSessions.size <= PRIOR_SESSIONS_KEYS) break
      if (k === key) continue
      priorRunSessions.delete(k)
    }
  }
}

/* ── 本轮在途登记表(reqId → 运行现场) ────────────────────────────────────
   steer / pause 是「往正在跑的这一轮里插一句话」与「让正在跑的这一轮停下来」:
   宿主手上只有它自己发 run 时编的 reqId、这一轮的 cancelTag(会话 agent:<id> /
   节点 id / assist)与权威 sessionId,而网关要下发到运行时,必须拿到**那一台**
   harness.client。tagToKey / keyToReqId 都以 runtime key 为轴,按 reqId 找现场
   只能整表扫,故再加一张正向表 —— 与 bridgePending 同族:键 = 网关侧能唯一辨识
   一次交互 / 一轮的编号,值 = 寻址现场。
   - runKey:这一轮占用的 runtime(claimRuntime 那一刻才成立,所以登记点就在 claim);
   - sessionId:对宿主报告的权威 id。claim 时先填网关铸造的 runSession,
     handleRun 的 emit('session')(含首条 session.event 改判后那次)刷新为权威值 ——
     下发 session/steer / session/pause 时按它点名会话。
   生命周期:claimRuntime 建 → handleRun 的 finally 清(与 keyToReqId 同进同退);
   表里只该有真正在途的轮,整表上限 INFLIGHT_RUNS_MAX,超出丢最早登记的(防泄漏)。 */
const INFLIGHT_RUNS_MAX = 256
/** @type {Map<string, {reqId: string, runKey: string, cancelTag: string, sessionId: string, startedAt: number}>} */
const inFlightRuns = new Map()

/* 暂停 / 插话的下达超时:两条都是「趁轮还在跑」的实时操作,10s 内拿不到回音就说明
   那台运行时根本不会响应(老运行时没有该方法 / 进程将死 / 卡住),按 unsupported 回
   宿主,宿主据此把这句插话回落成普通排队消息(超时口径参照 RESUME 握手:同为
   「运行中的一次同步往返」,但插话是即时操作,不给 30s 的读盘预算)。 */
const INFLIGHT_REQUEST_TIMEOUT_MS = 10000

/* 网关侧「本轮已被要求暂停」标记:reqId -> {at}。pause **下达之前**就先盖戳
   (见 handleInflightRequest):运行时收到暂停后往往在同一拍里就把这一轮 abort 收尾,
   等 request 的 await 回来再标记会漏判;下发失败再摘掉。handleRun 靠它把 aborted
   收成 done{paused:true},绝不 emit('error') —— 宿主的失败重发闸只看 error 事件,
   一次「暂停」会被它当成 429 类失败连着连重发 5 次。 */
const pausedRuns = new Map()

function noteInFlightRun(reqId, info) {
  const id = String(reqId == null ? '' : reqId).trim()
  if (!id) return
  const prev = inFlightRuns.get(id)
  if (prev) {
    if (info.runKey != null) prev.runKey = String(info.runKey)
    if (info.cancelTag != null) prev.cancelTag = tagOf(info.cancelTag)
    if (info.sessionId) prev.sessionId = String(info.sessionId)
    return
  }
  inFlightRuns.set(id, {
    reqId: id,
    runKey: String(info.runKey == null ? '' : info.runKey),
    cancelTag: tagOf(info.cancelTag),
    sessionId: String(info.sessionId || ''),
    startedAt: Date.now(),
  })
  while (inFlightRuns.size > INFLIGHT_RUNS_MAX) {
    const oldest = inFlightRuns.keys().next().value
    if (oldest === undefined) break
    inFlightRuns.delete(oldest)
  }
}

function clearInFlightRun(reqId) {
  const id = String(reqId == null ? '' : reqId).trim()
  if (!id) return
  inFlightRuns.delete(id)
  pausedRuns.delete(id)
}

/* 宿主怎么点名这一轮:reqId 最准(它自己编的);只给 cancelTag 时,同一个标签
   可能并发跑好几轮(某节点批量并行的视觉描述),再按 sessionId 收窄到其中一轮。
   与 cancel 同规矩:标签命中多轮时不猜测,整组一起下发(cancel 就是整组一起关)。 */
function findInFlightRuns(p) {
  const reqId = String(p.reqId == null ? '' : p.reqId).trim()
  if (reqId) {
    const e = inFlightRuns.get(reqId)
    return e ? [e] : []
  }
  const tag = tagOf(p.cancelTag)
  if (!tag) return []
  const hits = []
  for (const e of inFlightRuns.values()) if (e.cancelTag === tag) hits.push(e)
  const sid = String(p.sessionId == null ? '' : p.sessionId).trim()
  if (!sid || hits.length < 2) return hits
  const exact = hits.filter((e) => e.sessionId === sid)
  return exact.length ? exact : hits
}

/* unsupported = 宿主一律回落「排队」的口径:没有在途这一轮 / 那台 runtime 已不在池里 /
   老运行时没有 session/steer|pause / 下达超时。detail 只进日志与回执,不参与判定。 */
function inFlightUnsupported(detail) {
  return { ok: false, reason: 'unsupported', detail: String(detail || '').slice(0, 200) }
}

/* 只读自检（config/probe 桥 · 见 plugins/session-resume-server.mjs 的 PROBE_METHOD）：
   按 reqId/runKey 找到那台 live runtime，把它的生效装配（行 id + config）回给调用方。
   找不到 = 回 no_runtime / unsupported，绝不为探针新起一台运行时。 */
async function handleConfigProbe(p) {
  let entry = null
  const runKey = String(p.runKey == null ? '' : p.runKey).trim()
  if (runKey) entry = runtimes.get(runKey) || null
  if (!entry) {
    const runs = findInFlightRuns(p)
    for (const run of runs) {
      const hit = run.runKey ? runtimes.get(run.runKey) : null
      if (hit) { entry = hit; break }
    }
  }
  if (!entry) {
    /* 没有在途轮次时回退到最近建立的那台（冒烟探针在 run 收尾后仍要能读配置） */
    let newest = null
    for (const [, v] of runtimes) if (!newest || v.order > newest.order) newest = v
    entry = newest
  }
  if (!entry) return { ok: false, reason: 'no_runtime', detail: 'no live runtime in pool (keys=' + [...runtimes.keys()].length + ')' }
  let harness = null
  try {
    harness = await entry.harness
  } catch (err) {
    return { ok: false, reason: 'unsupported', detail: String((err && err.message) || err).slice(0, 200) }
  }
  const client = harness && harness.client
  if (!client || typeof client.request !== 'function') {
    return { ok: false, reason: 'unsupported', detail: 'runtime client cannot request' }
  }
  try {
    const probe = await client.request('config/probe', {}, 10000)
    return { ok: true, probe }
  } catch (err) {
    return { ok: false, reason: 'unsupported', detail: String((err && err.message) || err).slice(0, 200) }
  }
}

/* 插话正文:宿主可给 contentBlocks(与 session/prompt 同形),也可只给一句纯文本
   (text / content / input / message 任一)。两种形状都收下,下发时 contentBlocks
   与 text 同时带上 —— 运行时侧 session/steer 取哪种都取得到。没有正文就不是插话。 */
function steerContent(p) {
  const raw = [p.text, p.content, p.input, p.message].find(
    (x) => typeof x === 'string' && x.trim(),
  )
  const text = typeof raw === 'string' ? raw : ''
  const blocks = Array.isArray(p.contentBlocks) && p.contentBlocks.length
    ? p.contentBlocks
    : (text ? [{ type: 'text', text }] : null)
  if (!blocks) return null
  return text ? { contentBlocks: blocks, text } : { contentBlocks: blocks }
}

/* 把 steer / pause 下发给「正在跑这一轮的那台运行时」。
   同步往返:harness.client.request(method, {sessionId, …}, 10s)。
   任何一条送不出去都回 unsupported(宿主回落排队),绝不伪造成功。 */
async function handleInflightRequest(method, p) {
  const runs = findInFlightRuns(p)
  if (!runs.length) {
    const who = String(p.reqId == null ? '' : p.reqId).trim()
      ? 'reqId=' + String(p.reqId).trim()
      : 'cancelTag=' + (tagOf(p.cancelTag) || '(无)')
    diag(`inflight-none method=${method} ${who}`)
    return inFlightUnsupported(`no in-flight run for ${who}`)
  }
  const isPause = method === 'session/pause'
  const content = isPause ? null : steerContent(p)
  if (!isPause && !content) return inFlightUnsupported('missing steer content')
  const done = []
  let last = inFlightUnsupported('')
  for (const run of runs) {
    const sid = run.sessionId || String(p.sessionId == null ? '' : p.sessionId).trim()
    const entry = run.runKey ? runtimes.get(run.runKey) : null
    if (!sid) {
      last = inFlightUnsupported(`no sessionId for reqId=${run.reqId}`)
      continue
    }
    if (!entry) {
      last = inFlightUnsupported('runtime is not running')
      continue
    }
    /* 暂停:先盖戳再下发(见 pausedRuns 注释);下面任何一条失败路径都摘回去,
       否则这一轮的真实失败会被 handleRun 误吞成「暂停完成」而丢了报错。 */
    if (isPause) pausedRuns.set(run.reqId, { at: Date.now() })
    const undeliverable = (detail) => {
      if (isPause) pausedRuns.delete(run.reqId)
      last = inFlightUnsupported(detail)
    }
    let harness = null
    try {
      harness = await entry.harness
    } catch (err) {
      undeliverable(String((err && err.message) || err))
      continue
    }
    const client = harness && harness.client
    if (!client || typeof client.request !== 'function') {
      undeliverable('runtime client unavailable')
      continue
    }
    try {
      const r = await client.request(
        method,
        { sessionId: sid, ...(isPause ? {} : content) },
        INFLIGHT_REQUEST_TIMEOUT_MS,
      )
      /* 运行时明确说没接住（ok:false：那台进程里没有这条 live 会话 / 参数不合法）
         不等于送达。按成功回报的话，宿主会以为这句话已经进了本轮 —— 它既没进模型
         也没进队列，等于凭空丢掉；所以原样折算成 unsupported 交回宿主回落排队。 */
      if (r && r.ok === false) {
        undeliverable(`runtime refused: ${r.reason || "unknown"}`)
        continue
      }
      done.push({ reqId: run.reqId, sessionId: sid })
      diag(
        `inflight-ok method=${method} reqId=${run.reqId} sid=${sid} ` +
        `r=${JSON.stringify(r === undefined ? null : r).slice(0, 120)}`,
      )
    } catch (err) {
      const raw = String((err && err.message) || err)
      diag(`inflight-fail method=${method} reqId=${run.reqId} sid=${sid} err=${raw.slice(0, 160)}`)
      /* 超时特例(只影响 pause):请求很可能已经落进运行时、只是 10s 没回音,
         这时摘掉暂停标记,随后 aborted 收流就会被报成 error → 宿主把它当失败连重发 5 次。
         宁可多标一次,标记留着(本轮真正常收尾时宿主拿到的仍是完整 finalResponse),
         回执照样回 unsupported,让宿主回落排队。 */
      if (isPause && /timed ?out/i.test(raw)) {
        last = inFlightUnsupported(raw)
        continue
      }
      undeliverable(raw)
    }
  }
  if (!done.length) return last
  const res = {
    ok: true,
    reqId: done[0].reqId,
    sessionId: done[0].sessionId,
    reqIds: done.map((d) => d.reqId),
  }
  if (isPause) res.paused = true
  else res.steered = true
  if (done.length < runs.length) res.failed = runs.length - done.length
  return res
}

/* 登记一次运行对 runtime 的占用(同步完成,中间不 await,避免并发 run 抢同一台)。
   sessionId 在登记时就带上:真实轮的 session 由网关铸造(handleRun 的 runSession),
   所以第一帧交互到达前归属判据已经完整,不存在「先放行再补票」的空窗。 */
function claimRuntime(key, reqId, cancelTag, sessionId, hostSessionId) {
  if (reqId) {
    /* 上一轮没走正常收尾就被新一轮顶掉:先把它快照下来,别丢分类判据 */
    snapshotPriorSessions(key, keyToReqId.get(key))
    /* 新一轮正常占用这台 runtime:旧的「续跑候选」保活标记到此作废 —— 保活只
       服务于失败轮与宿主重发窗口之间的空窗期,一旦被占用即失去意义(防泄漏) */
    resumeCandidates.delete(key)
    const sid = String(sessionId || '')
    keyToReqId.set(key, {
      reqId, sessionId: sid,
      sessions: new Set(sid ? [sid] : []),
      /* 本轮的宿主(渲染层)会话 id:活动流条目的归属翻译靠它(见 hostSessionTagOf) */
      host: String(hostSessionId || ''),
      /* 本轮预热轮('ok')的 session,起机预热时补记(见 handleRun);仅用于日志分类 */
      warmSession: '',
    })
    /* steer / pause 的正向寻址表:reqId -> {runKey, cancelTag, sessionId}(见 inFlightRuns) */
    noteInFlightRun(reqId, { runKey: key, cancelTag, sessionId })
  }
  const tag = tagOf(cancelTag)
  if (tag) {
    let set = tagToKey.get(tag)
    if (!set) tagToKey.set(tag, (set = new Set()))
    set.add(key)
  }
  return tag
}

/* 此刻占用这台 runtime 的那一轮(没有 = 这台没有在途 run) */
function claimOf(key) {
  return keyToReqId.get(key) || null
}

/* 活动流的归属翻译：dsh 侧的 session id(`session-…`，浏览器 / 工具帧自带) 翻成
   宿主(渲染层)的会话 id(`as…`，run 参数 hostSessionId)。活动流面板按「当前会话」
   过滤(renderer/app-browser.js 的 BA.setSession)，而面板手里的会话 id 是渲染层的
   那一个 —— 没有这层翻译就永远对不上（历史实现里 BA.lastSessionId 从未赋值，
   于是永远查全库，切会话面板内容纹丝不动）。
   查不到(非会话轮 / 老宿主不下发 / run 已收尾)就原样返回，条目照旧可查（面板勾
   「含其它会话」看得到），绝不静默丢条目。 */
function hostSessionTagOf(dshSid) {
  const sid = String(dshSid || '')
  if (!sid) return ''
  for (const c of keyToReqId.values()) {
    if (!c || !c.host) continue
    if (c.sessionId === sid || (c.sessions && c.sessions.has(sid))) return c.host
  }
  return ''
}

/* 本轮在通知流里见到过的 session id 全部记入归属集合:
   真实轮自己 + 它派生出的子代理 / 后台 job(它们仍在这一棵会话树里)。
   别的 session(预热轮、上一轮遗留的进程内残留轮次)永远不会出现在本轮流里,
   因此永远进不了这个集合。 */
function noteRunSession(key, reqId, sessionId) {
  const c = keyToReqId.get(key)
  if (!c || !reqId || c.reqId !== reqId) return
  const sid = String(sessionId || '')
  if (sid) c.sessions.add(sid)
}

/* 改票:本轮首条 session.event 携带的 id 才是运行时真正在跑的 session。
   显式传的 sessionId 被忽略时(版本漂移/运行时自己另铸),以事件里的为准——
   否则本轮自己的提问会被自己门掉。改判成功返回新的权威 id,没改返回 ''。 */
function rebindRunSession(key, reqId, sessionId) {
  const c = keyToReqId.get(key)
  if (!c || !reqId || c.reqId !== reqId) return ''
  const sid = String(sessionId || '')
  if (!sid || c.sessionId === sid) return ''
  diag(`rebind reqId=${reqId} key=${shortKey(key)} from=${c.sessionId || '(空)'} to=${sid}`)
  /* 原来那个 id 已被证实现实里没人用它:从归属集合里摘掉,免得伪装帧蒙混过关 */
  if (c.sessionId) c.sessions.delete(c.sessionId)
  c.sessionId = sid
  c.sessions.add(sid)
  return sid
}

/* 记下本轮的预热轮 session(见 handleRun 的 fresh 分支)。预热轮合法跑在这台 runtime 里,
   但它既没有通知出口也没人会答它的提问 —— 单独记账,门控日志才能把它判成 warm,
   与「上一轮遗留」区分开。放行业判据不受影响:预热轮永远不在 claim.sessions 里。 */
function noteWarmSession(key, reqId, sessionId) {
  const c = keyToReqId.get(key)
  if (!c || !reqId || c.reqId !== reqId) return
  const sid = String(sessionId || '')
  if (sid) c.warmSession = sid
}

/* 越权帧是哪种来路(只影响日志措辞,放行与否早已由 claim.sessions 判定):
   no-sid   帧上根本没盖 sessionId(老插件/漏盖章)→ 归属不明,按越权处理
   warm     本轮预热轮('ok')在发起交互 —— 没人会应答,弹出来就是死框
   stale    上一轮遗留的后台 job / 子代理现在才醒 —— 它那一轮早收场了
   foreign  以上都不是:本轮会话树之外的 session,来路不明 */
function bridgeFrameOrigin(key, claim, sid) {
  if (!sid) return 'no-sid'
  if (claim && claim.warmSession === sid) return 'warm'
  const prior = priorRunSessions.get(key)
  if (prior && prior.has(sid)) return 'stale'
  return 'foreign'
}

/* 越权交互帧的统一处置:先回 abort(插件据此 reject,工具以失败收场,模型继续往下走,
   不会永远挂在那儿等一个不来的答案),再留一行能一眼定位的日志。
   没有这层门控,别人的轮次就能把确认框弹进你正在看的会话里。 */
function rejectBridgeFrame(key, claim, m, socket, sid) {
  try { socket.write(JSON.stringify({ t: 'abort', id: m.id }) + '\n') } catch {}
  diag(
    `reject ${m.t} origin=${bridgeFrameOrigin(key, claim, sid)} runKey=${shortKey(key)} ` +
    `reqId=${claim && claim.reqId ? claim.reqId : '(无在途轮)'} ` +
    `frameSid=${sid || '(无)'} runSid=${claim && claim.sessionId ? claim.sessionId : '(未定型)'} ` +
    `tree=${claim && claim.sessions ? claim.sessions.size : 0}`,
  )
}

/* 解除占用:只在自己的登记仍生效时清（同一台可能已被下一轮接手；
   被 cancel 关掉时 closeBridge/forgetKey 已经清过，这里不重复踩）。 */
function releaseClaim(key, reqId, tag) {
  const c = claimOf(key)
  const owns = !!reqId && !!c && c.reqId === reqId
  if (!owns) return false
  keyToReqId.delete(key)
  /* 本轮已结束:它的 session 从此变成「上一轮」,之后迟到的交互帧分类为 stale 并 abort */
  snapshotPriorSessions(key, c)
  if (tag) {
    const set = tagToKey.get(tag)
    if (set) {
      set.delete(key)
      if (!set.size) tagToKey.delete(tag)
    }
  }
  return true
}

/* 撤销一台 runtime 的在途交互(整轮结束 / 桥断开 / 进程被取消)。
   光通知插件不够:渲染层那张卡还在屏上,而网关侧 pending 已删,用户点任何选项
   都会撞上「交互已失效」→ 卡永远撤不掉(就是「弹窗选项全都没反应」的直接成因)。
   因此每撤一条都补发 ix-drop。ownerReqId 由调用方在解除占用**之前**取好,
   卡片才能挂回它所属那一轮;确实没有归属时发 reqId:'' 的全局撤卡帧,渲染层按 id 兜底撤卡。 */
function abortBridgePending(key, socket, ownerReqId) {
  const reqId = String(ownerReqId || (claimOf(key) && claimOf(key).reqId) || '')
  for (const [id, p] of bridgePending) {
    if (p.key !== key) continue
    if (socket && p.socket !== socket) continue
    bridgePending.delete(id)
    try { p.socket.write(JSON.stringify({ t: 'abort', id }) + '\n') } catch {}
    /* 撤卡通知不能反过来掀掉调用方:关闭流程里 stdout 可能已经断了 */
    try {
      out({ event: { reqId, type: 'ix-drop', data: { id, kind: p.kind, reason: 'aborted' } } })
    } catch {}
  }
}

function closeBridge(key) {
  const b = bridgeServers.get(key)
  forgetKey(key)
  /* 撤在途交互要赶在解除占用之前:那时 reqId 还在,ix-drop 才能挂到本轮头上 */
  abortBridgePending(key, null, claimOf(key) && claimOf(key).reqId)
  if (!b) return
  bridgeServers.delete(key)
  keyToReqId.delete(key)
  if (b.sockets) {
    for (const s of b.sockets) {
      try { s.destroy() } catch {}
    }
  }
  try { if (b.socket) b.socket.destroy() } catch {}
  try { b.server.close() } catch {}
}

function out(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/* ══════════════════════════════════════════════════════════════════════════
   会话自己的浏览器（browser_* 工具面的宿主侧）
   ──────────────────────────────────────────────────────────────────────────
   设计口径（用户已确认，见任务书与拷问共识）：
     · 底座＝系统 Edge/Chrome + CDP 直驱 + 独立用户数据目录（全局一份、跨会话保持登录态）；
     · 进程与 CDP 全在 browser-host.mjs，网关只做安全裁决与事件转发；
     · 一个浏览器进程、多标签，驱动串行化：同一时刻只让一条会话驱动；
     · 危险动作（提交 / 支付 / 删除 / 发送 / 发布…）弹确认卡（**恒开**，本轮需求：
       域名名单机制连同 browser-policy.json 一起删掉了，只剩这一条审批），
       复用既有提问/审批卡通道（browser 帧），用户拒绝即以失败收场、会话不中断；
     · 用户可「接管」：接管期间 Agent 的浏览器动作一律被拒（不是排队）；
     · 浏览器动作留痕（含导航 / 点击 / 输入长度 / 截图路径 / shell 命令）既实时推给
       渲染层的活动流面板，也落库在宿主侧（activity-store），不进模型上下文。
   ══════════════════════════════════════════════════════════════════════════ */

const BrowserCtl = {
  /* 最近一次 browser 帧的发起会话（活动流盖归属章用，见 push()） */
  lastSessionId: '',
  /* 浏览器进程 / 标签 / 驱动锁的只读快照（活动流面板与求助卡的真窗口通道共用） */
  status() {
    return { ...BrowserHost.statusOf(), takeover: BrowserHost.takeoverOf(), ok: true }
  },
  /* 宿主主动拉起浏览器（**本轮需求后唯一的调用方**：求助卡上的「用真窗口打开」）：
     不启动任何任务、不占驱动锁。这是唯一会带窗口的一只（用户口径：开发 / 会话过程中
     不该弹真窗口，只有他在求助卡上亲手点这一下才给一只看得见的）—— 带窗口起完紧接着
     parkSessionWindow，默认形态仍是内部界面；要真窗口由渲染层接着走 viewMode('detached')。
     visible:false（老宿主不传也算）时不带窗口：与浏览器工具默认那条路一致。

     重起前记住页面地址：无窗口那只与被要求「带窗口」的那只不是同一个进程（见
     browser-host 的 ensureBrowser），页面会回到 about:blank —— 刚弹的登录页就白丢了。
     只有**真的重起过**（r.reused === false）且原来停在 http(s) 页面上时才补一次导航。 */
  async open(opts) {
    const dsh = dshHomeDir()
    const wantVisible = !(opts && opts.visible === false)
    const before = wantVisible ? await this.currentUrl().catch(() => '') : ''
    const r = await BrowserHost.ensureBrowser({ profileDir: profileDirOf(dsh), dshHome: dsh, visible: wantVisible })
    try { await BrowserHost.setDownloadDir(downloadDirOf(dsh)) } catch {}
    if (r && r.reused === false && /^https?:/i.test(String(before || ''))) {
      try { await BrowserHost.navigate({ url: before, waitMs: 800 }) } catch { /* 恢复不了就算了，不拦这一步 */ }
    }
    try { await BrowserHost.parkSessionWindow() } catch {}

    /* 本轮修：无窗口那只在 CDP 里没有窗口可显形（实测 Browser.getWindowForTarget 回
       「Browser window not found」）→ 要真窗口只能温和关掉、重开一只带窗口的。这一条活动流
       就是给用户的交代（渲染层按 restartedForVisible 换一句 toast），免得他以为浏览器自己崩了。 */
    if (r && r.restartedForVisible) {
      this.push({ kind: 'browser', text: '这只没有真窗口可显形：已温和关掉、重开一只带窗口的（当前页面地址已带回）' })
    }
    return { ...r, ...this.status() }
  },
  async stop() {
    await BrowserHost.stopBrowser({})
    return this.status()
  },
  /* 用户接管 / 交还（浏览器窗口工具栏或求助卡触发）：接管期间 Agent 动作一律被拒 */
  takeover(on, sessionId) {
    BrowserHost.setTakeover(!!on, sessionId)
    this.push({ kind: 'takeover', text: on ? '你接管了浏览器（Agent 动作已暂停）' : '你交还了控制权（Agent 可继续）' })
    return this.status()
  },
  /* ── 实况流（会话主内容右边栏的「实况」区）───────────────────────────────
     用户口径：浏览器默认 dock 在右边栏、可交互；「提出来」= 真实窗口恢复可见，
     「收回」= 再 dock 回面板。帧只走内存回调 → 宿主事件（type 'browser-frame'），
     **绝不落库（activityPush 那条路）也绝不进模型上下文**。
     这几个方法都不申请驱动锁：它们只是「看」和窗口形态，不抢会话的驱动权。 */
  viewStatus() {
    return { ok: true, ...BrowserHost.viewStatus() }
  },
  async viewStart(params) {
    /* 只连「已经在跑的」那只浏览器：实况是观察面，绝不因为它自己把浏览器拉起来
       （用户口径：没被调用 / 没启动 = 整条不显示，也不该顺手启动）。 */
    const st = BrowserHost.statusOf()
    if (!st.running) {
      return { ok: false, error: '浏览器没在跑（让会话调用 browser_launch，或在求助卡上点「用真窗口打开」）', ...BrowserHost.viewStatus() }
    }
    const r = await BrowserHost.startViewStream(params || {})
    /* 开流即停靠：**默认形态就是内部界面**（真实窗口移出可视区，画面只在右栏实况里）。
       判据必须是「真的搬走了没有」（parked），不能只看 mode —— mode 默认就是 docked，
       新起的窗口却还摆在屏幕上，只看 mode 会漏搬，用户看到的仍是「面板有画面、屏幕上多一只 Edge」。
       「独立窗口」是用户在求助卡上亲手点的例外（viewMode === 'detached'），那时不许把它搬回去 ——
       否则他刚点开真窗口就被自动收走，等于那个按钮点不动。 */
    const vs = BrowserHost.viewStatus()
    if (vs.mode !== 'detached' && (vs.mode !== 'docked' || !vs.parked)) {
      await BrowserHost.setViewMode('docked')
    }
    return { ok: true, ...r }
  },
  async viewStop() {
    return { ok: true, ...(await BrowserHost.stopViewStream()) }
  },
  async viewInput(params) {
    const r = await BrowserHost.viewInput(params || {})
    return { ok: true, ...r }
  },
  async viewMode(mode) {
    const r = await BrowserHost.setViewMode(mode)
    return { ok: r.ok !== false, ...r }
  },
  push(item) {
    /* 归属会话：条目自己带的（工具 / 命令 / 文件类摘要，handleRun 按 hostSessionId 盖）
       优先，否则回落到「最近一次 browser 帧的发起会话」。两者都是 dsh 侧 id 时先翻成
       宿主会话 id（见 hostSessionTagOf），面板才认得出这条属于哪条会话。
       显式带了 sessionId 的条目就按它来（哪怕是空串 = 这一轮没有归属会话）——
       非会话轮（画布节点 / 助手）的行不该被顺手算进某条会话的账上。 */
    const hasOwn = !!(item && Object.prototype.hasOwnProperty.call(item, 'sessionId'))
    const raw = hasOwn ? String(item.sessionId || '') : String(this.lastSessionId || '')
    const data = {
      at: Number(item && item.at) || Date.now(),
      kind: String((item && item.kind) || 'browser'),
      text: String((item && item.text) || '').slice(0, 600),
      sessionId: hostSessionTagOf(raw) || raw,
      ...(item && item.path ? { path: String(item.path) } : {}),
    }
    try { out({ event: { reqId: '', type: 'browser-act', data } }) } catch { /* stdout 已断 */ }
  },
  /* 判定一条浏览器动作该不该先问用户：返回 null = 直接执行。
     本轮需求：域名名单机制（拦截名单 / 风险站点首次确认）连同 browser-policy.json
     一起删掉了 —— 导航不再有域名级闸门，只剩下面这条**恒开**的危险动作审批。 */
  async gate(op, params) {
    if (BrowserHost.isTakeover()) {
      const who = BrowserHost.takeoverOf().sessionId
      return { ask: false, deny: `浏览器此刻由用户接管${who ? '（' + who.slice(0, 12) + '…）' : ''}：Agent 动作一律暂停。请等用户交还控制权（browser_help 或求助卡上的「交还控制权」），或先用 browser_help 说明你需要什么。` }
    }
    if (op === 'click' && APPROVE_DANGEROUS) {
      const d = dangerOfClick(params && params.label, params && params.text)
      if (d.danger) {
        return {
          ask: true,
          askData: {
            kind: 'confirm',
            title: '危险动作确认',
            message: `${d.why}。即将在页面上执行：${String((params && params.label) || (params && params.selector) || '').slice(0, 120)}`,
            danger: true,
            /* 卡片上带一行「当时在哪个页面」：危险动作必须能看清是在哪儿按的 */
            url: await this.currentUrl(),
          },
        }
      }
    }
    return null
  },
  /* 问用户一次（浏览器帧通道）：回 'allowed-once' | 'rejected' | 'cancelled' */
  ask(key, sessionId, askData) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID()
      const claim = claimOf(key)
      const reqId = claim ? claim.reqId : ''
      const sock = this.socketFor(key)
      if (!sock) return resolve('cancelled')
      const payload = { id, sessionId, ...askData }
      bridgePending.set(id, {
        socket: sock,
        key,
        kind: 'browser',
        reqId,
        sessionId,
        resolve: (v) => resolve(v || 'cancelled'),
        reject: () => resolve('cancelled'),
      })
      out({ event: { reqId, type: 'browser', data: { ...askData, id, sessionId } } })
      setTimeout(() => {
        if (!bridgePending.has(id)) return
        bridgePending.delete(id)
        out({ event: { reqId, type: 'ix-drop', data: { id, kind: 'browser', reason: 'aborted' } } })
        resolve('cancelled')
      }, 10 * 60 * 1000)
    })
  },
  socketFor(key) {
    const b = bridgeServers.get(key)
    if (!b || !b.sockets || !b.sockets.size) return null
    for (const s of b.sockets) {
      if (!s.destroyed) return s
    }
    return null
  },
  /* browser 帧的总入口：返回 {ok, result} 或抛错（由调用处折算成 browser-result） */
  /* 当前标签页 URL（求助卡 / 确认卡上要显示「卡在哪个页面」）。
     浏览器没起来 / 页面还没导航 → 回空串：卡片少一行，不影响求助本身。 */
  async currentUrl() {
    try {
      const r = await BrowserHost.evaluateJs({ expression: 'location.href', note: '读当前地址' })
      return String((r && r.value) || '').slice(0, 400)
    } catch {
      return ''
    }
  },
  /* ── 实况视图：右栏面板的帧与「提出来 / 收回」（见 BrowserCtl 顶部的 view* 方法）── */
  async viewHandle(p) {
    const patch = p && typeof p === 'object' ? p : {}
    const method = String(patch.method || 'status')
    if (method === 'status') return { ok: true, result: this.viewStatus() }
    if (method === 'start') return { ok: true, result: await this.viewStart(patch.params) }
    if (method === 'stop') return { ok: true, result: await this.viewStop() }
    if (method === 'input') return { ok: true, result: await this.viewInput(patch.params) }
    if (method === 'mode') return { ok: true, result: await this.viewMode(patch.mode) }
    throw new Error('未知的实况视图方法：' + method)
  },
  async handle(key, m) {
    const op = String(m.op || '')

    /* 本轮修：把「刚才在跑的是什么动作」记进宿主 —— 浏览器异常退出那条留痕要带上它
       （真排障时最想知道的就是「它没的那一下正在干什么」）。status 只是读状态，不记。 */
    if (op && op !== 'status') BrowserHost.setLastAction(op)
    const params = m.params && typeof m.params === 'object' ? m.params : {}
    const sessionId = String(m.sessionId || '')
    const dsh = dshHomeDir()
    /* 记下发起会话：BrowserCtl.push() 给活动流条目盖归属章用（面板默认按会话过滤） */
    if (sessionId) this.lastSessionId = sessionId

    if (op === 'status') return { ok: true, result: this.status() }

    /* 申请驱动（串行化）：一条会话独占浏览器，避免两个会话抢同一个页面 */
    if (op !== 'release') {
      const claim = BrowserHost.claimDriver(sessionId)
      if (!claim.ok) throw new Error(claim.reason)
    }

    if (op === 'launch') {
      /* 会话自动拉起的那只**不带窗口**（visible 缺省 false → headless）：开发 / 会话过程中
         屏幕上不该弹真窗口，画面与截图全走 CDP（本机实测 screencast 照常出帧）。
         想看真窗口只有一条路：用户在求助卡上亲手点「用真窗口打开」（见 open()）。 */
      const r = await BrowserHost.ensureBrowser({ profileDir: profileDirOf(dsh), dshHome: dsh, visible: !!params.visible })
      await BrowserHost.setDownloadDir(downloadDirOf(dsh)).catch(() => {})
      /* 会话启用浏览器的默认形态 = **内部界面**：进程照常起（登录态不变），但真实窗口
         立刻移出可视区 —— 用户口径是「启用时不该另开一个新窗口，画面就来内部的实况区」。
         不在这里停靠的后果：spawn 出来的窗口戳在屏幕上，只有「渲染层恰好开着右栏去开流」
         那条路才会搬运它（右栏没开 / 焦点不在该会话时根本不会开流）→ 用户看到多一只 Edge。
         用户从求助卡点过「用真窗口打开」的那一轮例外：mode === 'detached' 时不搬回去（见 viewStart）。 */
      if (BrowserHost.viewStatus().mode !== 'detached') {
        try { await BrowserHost.parkSessionWindow() } catch { /* 搬不动：实况侧有 fallback 兜底 */ }
      }
      this.push({ kind: 'browser', text: `浏览器就绪（${String(r.exe).includes('msedge') ? 'Edge' : 'Chrome'} · ${r.reused ? '复用已开的窗口' : '新启动'} · 内部界面）` })
      return { ok: true, result: { ...r, ...this.status() } }
    }
    if (op === 'release') {
      BrowserHost.releaseDriver(sessionId)
      this.push({ kind: 'browser', text: '会话交还了浏览器驱动' })
      return { ok: true, result: { ok: true } }
    }

    /* 除 launch / release 外都要浏览器已经起来（没起就先起，用户口径是「按需自动拉起」）——
       按需自动拉起同样不带窗口（visible 缺省 false）；用户要真窗口只有求助卡「用真窗口打开」那一下。 */
    await BrowserHost.ensureBrowser({ profileDir: profileDirOf(dsh), dshHome: dsh, visible: !!params.visible })
    await BrowserHost.setDownloadDir(downloadDirOf(dsh)).catch(() => {})

    if (op === 'snapshot') return { ok: true, result: await BrowserHost.snapshot(params) }
    if (op === 'network') return { ok: true, result: await BrowserHost.network(params) }
    if (op === 'tabs') return { ok: true, result: await BrowserHost.tabs(params) }
    if (op === 'wait') return { ok: true, result: await BrowserHost.waitFor(params) }
    if (op === 'eval') return { ok: true, result: await BrowserHost.evaluateJs(params) }
    if (op === 'screenshot') {
      const p = { ...params, dir: shotsDirOf(dsh) }
      const r = await BrowserHost.screenshot(p)
      return { ok: true, result: { ...r, note: '读这张图请用 mtnode_vision（绝对路径）' } }
    }
    if (op === 'key') return { ok: true, result: await BrowserHost.pressKey(params) }
    if (op === 'type') return { ok: true, result: await BrowserHost.typeText(params) }

    if (op === 'navigate' || op === 'click' || op === 'submit') {
      /* 安全闸：只剩恒开的危险动作审批（域名名单已删）。拒绝 = 失败回执，会话不中断。 */
      const g = await this.gate(op, params)
      if (g && g.deny) throw new Error(g.deny)
      if (g && g.ask) {
        const outcome = await this.ask(key, sessionId, g.askData)
        if (outcome === 'rejected') throw new Error('用户拒绝了这次操作（' + String(g.askData.title || '') + '），请换一条路或先向用户说明。')
        if (outcome !== 'allowed-once') throw new Error('这次操作的确认已失效（发起轮已结束或用户撤下卡片）。')
      }
      if (op === 'navigate') return { ok: true, result: await BrowserHost.navigate(params) }
      const r = await BrowserHost.click(params)
      return { ok: true, result: r }
    }

    if (op === 'help') {
      /* 浏览器求助卡：登录墙 / 待验证 / 需补充信息 / 卡住 / 危险动作。
         登录类默认进入「用户接管」，用户交还后本工具以 released 收场。 */
      const kind = String(params.kind || 'blocked')
      const askData = {
        kind: 'help',
        helpKind: kind,
        title: kind === 'login' ? '需要你登录 / 处理页面验证'
          : kind === 'verify' ? '请你验证这个结果'
            : kind === 'choice' ? '需要你补充信息或做选择'
              : kind === 'danger' ? '危险动作需要你确认'
                : '会话卡住了，需要你帮忙',
        message: String(params.message || ''),
        options: Array.isArray(params.options) ? params.options.map((x) => String(x).slice(0, 120)).slice(0, 8) : [],
        screenshotPath: String(params.screenshotPath || ''),
        note: String(params.note || ''),
        /* 卡片上要显示「它当时卡在哪个页面」：能取到当前 URL 就带上，取不到留空
           （渲染层对空串就是少一行，不占位）。 */
        url: await this.currentUrl().catch(() => ''),
        takeover: kind === 'login',
      }
      this.push({ kind: 'help', text: `${askData.title}：${askData.message.slice(0, 200)}` })
      /* 登录类求助：接管（他的动作优先，Agent 动作一律被拒），但**形态仍是内部界面**
         —— 用户口径：接管 / 登录也走右栏实况区，不再为了「看见窗口」把真窗口抬出来
         （bringToFront 是「又开出一个窗口」的第二条来源）。他从求助卡点「用真窗口打开」才是例外。
         接管期间画面照常出帧，所以登录 / 验证码在实况区里就能操作。 */
      if (kind === 'login') BrowserHost.setTakeover(true, sessionId)
      const outcome = await this.ask(key, sessionId, askData)
      if (kind === 'login') BrowserHost.setTakeover(false, sessionId)
      const res = {
        outcome: outcome === 'rejected' ? 'cancelled' : outcome,
        takeover: kind === 'login',
        takeoverReleased: kind === 'login',
        hint: kind === 'login'
          ? '用户已交还控制权；下一步请用 browser_snapshot 看当前页面状态再继续。'
          : kind === 'choice'
            ? '用户的回答在上面的 answer 字段里；若为空说明用户撤下了这张卡。'
            : '用户已回应；用 browser_snapshot 确认页面现状后继续。',
      }
      if (typeof outcome === 'object' && outcome) Object.assign(res, outcome)
      return { ok: true, result: res }
    }
    throw new Error('未知的浏览器操作：' + op)
  },
}

/* 浏览器动作留痕 → 宿主事件（活动流面板实时显示 + 宿主落库） */
BrowserHost.registerActivitySink((item) => BrowserCtl.push(item))

/* 实况帧 → 宿主事件（type 'browser-frame'）。硬约束：不走 push()、不落库、不进模型
   上下文 —— 帧只在网关 → 宿主 → 渲染层这条内存通路上跑（用户已确认的口径）。 */
BrowserHost.registerViewSink((f) => {
  try { out({ event: { reqId: '', type: 'browser-frame', data: f } }) } catch { /* stdout 已断 */ }
})

/* 工具入参 → 一行活动流摘要（命令 / 路径 / 一小段查询）。凭据纪律：长文本与
   疑似密钥一律只记长度，不记内容（与浏览器 type 的 secret 口径一致）。 */
function summarizeToolArgs(args) {
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { a = { raw: a } }
  }
  if (!a || typeof a !== 'object') return ''
  const pick = ['command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'url', 'query', 'expr', 'expression', 'text', 'content', 'prompt']
  for (const k of pick) {
    const v = a[k]
    if (typeof v !== 'string' || !v.trim()) continue
    const one = v.replace(/\s+/g, ' ').trim()
    const secretish = /password|passwd|secret|token|api[-_]?key|authorization|card|cvv/i.test(k) || /^(sk-|ghp_|Bearer )/.test(one)
    if (secretish) return `${k}=（敏感，${one.length} 字符，未记录）`
    return `${k}=${one.length > 120 ? one.slice(0, 120) + '…' : one}`
  }
  return ''
}

/* 工具输出 → 活动流摘要（只留前 300 字符；完整输出仍在会话里，活动流只作核对） */
function summarizeToolOutput(content, error) {
  if (error) return '失败：' + String(error).slice(0, 200)
  if (!Array.isArray(content) || !content.length) return ''
  const parts = []
  for (const b of content) {
    if (b && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.replace(/\s+/g, ' ').trim())
    else if (b && b.type) parts.push('[' + String(b.type) + ']')
  }
  const one = parts.join(' ').slice(0, 300)
  return one || ''
}

/* sid → 目录名的**单一真源**净化式子:「会话是否可续跑」的日志查找走它。
   网关自铸的 id 本就是 ASCII(`session-<uuid hex>`),净化对它恒等;路径分隔符等
   非法字符换成 `_` 并截断到 120。 */
function normSessionId(sessionId) {
  return String(sessionId == null ? '' : sessionId)
    .trim()
    .replace(/[^A-Za-z0-9_.\-\u4e00-\u9fff]/g, '_')
    .slice(0, 120)
}

/* 续跑可用性判据 —— **第一道闸(必要不充分)**:<DSH_HOME>/sessions 下是否真的存着这个
   会话的日志。运行时侧 dsh-session-persistence-jsonl 的落盘布局是
     <root>/<projectKey(cwd)>/<sid>/session.jsonl        (compression: none)
     <root>/<projectKey(cwd)>/<sid>/session.jsonl.zstd   (默认 zstd)
   project 目录名由 workspace 推导、宿主未必拿得准,所以按 sid 扫 sessions 下的一层
   project 目录,任一命中即「本机存过这个会话」(session id 全局唯一,不会串到别的 workspace)。
   文件在盘 ≠ 续得上:真续与否还看这台 runtime 有没有该会话的 live 句柄(状态 A 同进程
   命中)、或能否经续跑轮 run 前的 session/resume 握手从盘上恢复(状态 B 跨进程恢复);
   只有两者都不成才走 RESUME_UNAVAILABLE(状态 C)。完整三态见 dsh/DESIGN.md「断点续跑契约」。
   刻意只依赖 node 内置 fs/path、纯只读(不建目录 / 不打日志 / 不起 runtime):测试可以
   用 vm 把 normSessionId / SESSION_LOG_FILES / resumeSessionExists 抠出来,配假目录
   夹具直接跑,不需要真实 LLM。
   注:运行时给 sid 做路径编码时只放行 [A-Za-z0-9._-],其余转成 `~XXXX`;网关自铸与
   宿主回传的 id 都是 `session-<hex>` 形态,净化即恒等,因此这里直接按净化后的 sid 找目录。 */
const SESSION_LOG_FILES = ['session.jsonl', 'session.jsonl.zstd']

function resumeSessionExists(dshHome, sessionId) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim()
  const sid = normSessionId(sessionId)
  /* 净化保留了点,`.` / `..` 是往上跳一级的口子:一律判不可续跑 */
  if (!home || !sid || sid === '.' || sid === '..') return false
  const root = path.join(home, 'sessions')
  let projects = []
  try {
    /* sessions 根目录还不存在 = 一个会话都没落过盘 */
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const ent of projects) {
    if (!ent || !ent.isDirectory()) continue
    for (const file of SESSION_LOG_FILES) {
      try {
        if (statSync(path.join(root, ent.name, sid, file)).isFile()) return true
      } catch { /* 这个 project 下没有该会话:看下一个 */ }
    }
  }
  return false
}

/* 运行时侧 dsh-session-persistence 的「盘上日志接不上」冲突文案(续跑专属)。接入
   session/resume 桥(见 plugins/session-resume-server.mjs)后,续跑轮先经握手让运行时从
   盘上恢复(状态 B 跨进程真续),同进程命中更是零开销(状态 A)—— 故 persistence 的
   `(id collision)` 只在**真正不可恢复**时出现:老运行时没有 session/resume 而回落原
   create 语义(新 runtime 以「新会话 + 只有续跑指令的 seed」去碰盘上旧日志,persistence
   在 session/created 判前缀不符即抛),或恢复被拒后仍落到 create 路径。对宿主的语义与
   RESUME_UNAVAILABLE 相同:续不上 → 退回整轮重发,绝不能把它当普通错误透传(宿主会拿
   同一个 dead id 连撞 5 次重发预算)。三态见 dsh/DESIGN.md「断点续跑契约」。
   命中返回按 RESUME_UNAVAILABLE 契约转译的文案(前缀是宿主识别口径,改契约要同改宿主);
   未命中返回空串。只应在续跑轮(resumed=true)上调用。 */
const RESUME_COLLISION_RE = /\(id collision\)|persisted log on disk|does not match this live session|persisted at a different cwd|bound to a different live session/

function resumeCollisionMessage(message, sid) {
  const s = String(message || '')
  if (!RESUME_COLLISION_RE.test(s)) return ''
  const who = String(sid == null ? '' : sid).trim() || '(未知)'
  return (
    'RESUME_UNAVAILABLE: 会话 ' + who +
    ' 盘上留有旧会话日志但运行时已无法续接（旧日志与实时会话不符，id collision），请改为整轮重发'
  )
}

/* 图像附件:按 dsh-attachment-local 的内容寻址布局,把图像写入
   DSH_HOME/attachments/v1/objects/<sha 前2位>/<sha256>,
   返回 harness 用户消息的 image 内容块(引用 attachmentId)。
   readImageFile 会用 sharp 校验 mediaType/bytes/宽高,故此处用同一
   sharp 探针取值,保证元数据一致。 */
const ATTACH_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
let sharpProbe = null
async function probeImageMeta(buf) {
  /* sharp 为可选依赖:加载失败只影响图像附件,不影响文本任务 */
  try {
    if (!sharpProbe) sharpProbe = (await import('sharp')).default
    return await sharpProbe(buf, { failOn: 'none' }).metadata()
  } catch {
    return null
  }
}
async function attachImages(home, paths) {
  const out = []
  const root = path.join(home || process.env.DSH_HOME || '', 'attachments', 'v1')
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!p || typeof p !== 'string') continue
    try {
      const buf = readFileSync(p)
      const meta = await probeImageMeta(buf)
      if (!meta) continue
      const mediaType = ATTACH_MIME[meta.format]
      if (!mediaType || !(meta.width > 0) || !(meta.height > 0)) continue
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      const dir = path.join(root, 'objects', sha.slice(0, 2))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, sha), buf)
      out.push({
        type: 'image',
        attachment: {
          attachmentId: 'sha256:' + sha,
          mediaType,
          bytes: buf.length,
          width: meta.width,
          height: meta.height,
        },
      })
    } catch {
      /* 单个图像读取/探测失败仅跳过,不阻断任务 */
    }
  }
  return out
}

/* SDK 握手：可重试的失败有两类 ——
   ① `no adapter registered`：运行时组合的 settings 文档由 chokidar 异步载入，llm-pi-ai
      的 mtnode/pi-ai 路由在起机约 0.5~1s 后才注册进适配器表（见下）；
   ② 握手超时（timed out after … waiting for dsh profile …）：冷起偶发慢，SDK 的
      start() 失败时会 close 掉旧客户端、换一只新的，所以重试 = 换一台新子进程重来。
   ③ 以外的一律上抛（宿主拿可读错误）。超时重试单独限次：每次最多等
   INITIALIZE_TIMEOUT_MS（60s），别让一条真挂住的运行时把这一轮拖成几分钟。 */
function warmHandshakeRetryable(err) {
  const msg = String((err && err.message) || err || '')
  const name = (err && err.name) || ''
  return /no adapter registered/.test(msg) || name === 'RequestTimeoutError' || /waiting for dsh profile/.test(msg)
}

/* SDK 握手预热:运行时组合的 settings 文档由 chokidar 异步载入,
   llm-pi-ai 的 mtnode/pi-ai 路由在启动约 0.5~1s 后才注册进适配器表。
   立即 initialize 会在首个请求报 "no adapter registered for provider ..."
   (deepseek-official 由 SDK 服务端自挂载,首试即成功)。失败仅重试该握手,
   运行时进程保持存活。 */
async function warmStartHarness(harness) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let lastErr
  let timeoutRetries = 0
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      /* 0.2：握手参数（cwd / provider / model / maxTokens）改由构造函数接管，
         高层 start() 自带「只握手一次 + 失败换新客户端」语义。 */
      await harness.start()
      return harness
    } catch (err) {
      lastErr = err
      if (!warmHandshakeRetryable(err)) throw err
      const isTimeout = (err && err.name) === 'RequestTimeoutError' || /waiting for dsh profile/.test(String((err && err.message) || ''))
      /* 超时最多重试 2 次（合计最多 3 次握手）；适配器竞态照旧给满 6 次 */
      if (isTimeout && ++timeoutRetries > 2) throw err
      diag('harness 握手失败，重试 ' + (attempt + 1) + '/6（' + (isTimeout ? '超时' : '适配器未就绪') + '）：'
        + String((err && err.message) || err).slice(0, 300))
      await sleep(isTimeout ? 800 : 400)
    }
  }
  throw lastErr
}

function runtimeKey(workspace, model, maxTokens, provider, apiKey, baseUrl, provHash, effort) {
  const secret = crypto.createHash('sha1').update(apiKey ?? '').digest('hex').slice(0, 12)
  const eff = effortKeyOf(effort)
  return [workspace, model, maxTokens, provider, secret, baseUrl ?? '', provHash, eff].join('|')
}

/* 并发隔离:同一配置档(baseKey)的 runtime 若已被某次在途 run 占用,后来者必须另起一台
   (key##tag)。否则两次运行共用一个进程,取消任一个都会把另一个一起打断。
   空闲时仍复用同一台,顺序批处理不额外付进程启动开销。 */
function pickRuntimeKey(baseKey, cancelTag) {
  if (!keyToReqId.has(baseKey)) return baseKey
  const tag = tagOf(cancelTag).replace(/[^A-Za-z0-9_.:\-]/g, '_')
  let k = tag ? baseKey + '##' + tag : baseKey + '##run'
  let n = 1
  while (keyToReqId.has(k)) k = (tag ? baseKey + '##' + tag : baseKey + '##run') + '#' + ++n
  return k
}

async function getRuntime(workspace, model, maxTokens, provider, apiKey, baseUrl, dshHome, envPatch, effort, webSearchApiKey, hostPersona, cancelTag, reqId, pure, runSession, hostSessionId, toolsJson, lean, noCanvas, hideTools, noBrowser) {
  const home = dshHome || process.env.DSH_HOME || ''
  const effMaxTokens =
    Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Math.round(Number(maxTokens))
      : undefined
  const searchKey = String(webSearchApiKey || '').trim() || String(apiKey || '').trim()
  const personaHash = crypto.createHash('sha1').update(String(hostPersona || '')).digest('hex').slice(0, 12)
  const pureOn = !!pure
  /* 按运行裁剪工具负载（两个标记都进 runtime key + spawn env，见下方 lean: / nc:）：
     · leanOn     —— 设置里的「精简工具负载」：运行时不注册 mtnode_app / mtnode_vision；
     · noCanvasOn —— 画布智能节点（nodeLock）运行：不注册 mtnode_canvas_get /
                     mtnode_canvas_edit / mtnode_app（宿主本来就拒收这些帧）。
     真正的丢弃动作在 canvas-plugin.mjs 的 register()（唯一判定点），这里只下达标记。 */
  const leanOn = !!lean
  const noCanvasOn = !!noCanvas
  /* 第四个整档标记：浏览器工具（browser_*）只给会话用。画布智能节点 / 用户声明的
     「与画布无关」会话 / 长任务未授权环节都由宿主打这一位 → 运行时整只不注册
     browser-plugin.mjs（约 12 个工具的 schema 一步都不发）。 */
  const noBrowserOn = !!noBrowser
  /* 第三通道 hideTools：宿主按运行算出的「这一轮根本不该存在的工具名」清单（数组或
     逗号串）。归一只认 tool-visibility.mjs 的白名单、去重、字典序排序 —— 同一档会话
     每轮算出的字符串逐字相同，指纹才稳定，提示缓存才不会被打爆。pure 轮画布 / 数据库
     等插件已被 cordis 整体禁用，名单无意义 → 归零。 */
  const hiddenEnv = pureOn ? '' : normalizeHiddenTools(hideTools).join(',')
  const hxHash = hiddenEnv
    ? crypto.createHash('sha1').update(hiddenEnv).digest('hex').slice(0, 12)
    : ''
  /* 用户工具描述子：指纹进 runtime key（工具集变化 → 冷起自己的运行时），
     原文进 spawn env 供 tools-plugin.mjs 注册；空串则清除。 */
  const tlHash = toolsJson
    ? crypto.createHash('sha1').update(String(toolsJson)).digest('hex').slice(0, 12)
    : ''
  const baseKey = runtimeKey(
    workspace,
    model,
    effMaxTokens ?? 0,
    provider,
    apiKey,
    baseUrl,
    /* lean: / nc: = 两个可见工具集标记。它们改变的是「运行时里注册了哪些工具」，
       即固定前缀的 tools 段本身 —— 不进 key 就会出现同一台运行时被两种可见集复用，
       既打爆提示缓存又让「精简」变成随机行为，所以必须与 pure: / tl: 同级。
       hx: = 同一件事的第三通道（按名字的隐藏名单，见 hideTools），同一档必得同一台。 */
    (envPatch ? JSON.stringify(envPatch) : '') + '|ws:' + searchKey.slice(0, 8) + '|hp:' + personaHash + '|pure:' + (pureOn ? '1' : '0') + '|tl:' + tlHash + '|lean:' + (leanOn ? '1' : '0') + '|nc:' + (noCanvasOn ? '1' : '0') + '|nb:' + (noBrowserOn ? '1' : '0') + '|hx:' + hxHash,
    effort,
  )
  const key = pickRuntimeKey(baseKey, cancelTag)
  const existing = runtimes.get(key)
  if (existing) {
    existing.order = ++runtimeOrder
    /* 复用也要先占住:一旦返回给 handleRun,中间让出事件循环就会被并发 run 抢走 */
    claimRuntime(key, reqId, cancelTag, runSession, hostSessionId)
    return { harness: existing.harness, key, fresh: false }
  }
  mkdirSync(workspace, { recursive: true })
  const env = { ...process.env }
  if (home) env.DSH_HOME = home
  else delete env.DSH_HOME
  /* 联网搜索(dsh-web-search-deepseek)只认 DEEPSEEK_API_KEY，且固定打
     api.deepseek.com/anthropic — 必须用 DeepSeek 官方 Key，不能用当前对话
     所选第三方服务商的 Key。对话路由密钥经 MTNODE_KEY_* / llm 适配器注入。 */
  if (searchKey) env.DEEPSEEK_API_KEY = searchKey
  else if (apiKey) env.DEEPSEEK_API_KEY = apiKey
  else delete env.DEEPSEEK_API_KEY
  /* dsh 0.2 的 llm-deepseek 把 baseURL 当「Messages 兼容根」，自己拼 /v1/messages；
     而 MTNode 配置里存的是 OpenAI 兼容根（https://api.deepseek.com）—— 直接下发会打到
     https://api.deepseek.com/v1/messages（实测 404）。归一规则见 messages-base-url.mjs：
     只给官方裸根补 /anthropic，其它端点原样透传。 */
  if (baseUrl) env.DEEPSEEK_BASE_URL = messagesBaseUrl(baseUrl)
  else delete env.DEEPSEEK_BASE_URL
  delete env.DSH_PERMISSION_MODE
  /* 遥测关断:dsh 基座的组合里自带两行 OTel(dsh-otel / dsh-session-telemetry-otel,
     FEEDBACK_ONLY 口径),它们在这台机器的运行时里导入失败 —— 每次启动都在 stderr 刷两条
     `failed to import`(实测:这两个包单独 import 都成功,是运行时导入路径的问题,不是缺依赖)。
     两行的**稳定**关断在 cordis.yml(按 id 标 disabled);这里再补 dsh 官方退出开关:
     任何非空值即禁用(含 '0'/'false'),组合里没有遥测行时它无副作用。不参与 runtime key:
     它不影响模型能力 / 工具集,换档不必多起进程。 */
  env.DSH_TELEMETRY_DISABLED = '1'
  /* BongoChat：人设经环境变量注入运行时插件（dsh-system-prompt 不读 settings.yaml） */
  const personaText = hostPersona && String(hostPersona).trim()
  if (personaText) {
    env.MTNODE_CHAT_ISOLATE = '1'
    env.MTNODE_HOST_PERSONA = personaText
  } else {
    delete env.MTNODE_CHAT_ISOLATE
    delete env.MTNODE_HOST_PERSONA
  }
  /* 纯净模式：注入 MTNODE_PURE=1 给运行时。pure-prompt 插件据此在系统提示装配时
     清空全部 system prompt 段与运行时上下文、工具只保留联网搜索；cordis.yml 用同一
     标记门控禁用画布 / 数据库 / 回滚 / 文件 / 命令 / 技能等 MTNode 工具插件。 */
  if (pureOn) env.MTNODE_PURE = '1'
  else delete env.MTNODE_PURE
  /* 按运行裁剪工具负载的三个标记 → env（读点：canvas-plugin.mjs 的 register()、
     db-plugin.mjs 的注册口、以及按名字裁剪的 mtnode-tool-visibility 插件）。
     缺席 / 空 = 全量注册，行为与未接入本能力时一字不差。 */
  if (leanOn) env.MTNODE_LEAN_TOOLS = '1'
  else delete env.MTNODE_LEAN_TOOLS
  if (noCanvasOn) env.MTNODE_NO_CANVAS = '1'
  else delete env.MTNODE_NO_CANVAS
  /* 浏览器工具整档闸（browser-plugin.mjs）：仅会话可用，节点 / 与画布无关 / 长任务
     未授权环节整只不注册。与 lean / noCanvas 同进 runtime key（nb: 成分）。 */
  if (noBrowserOn) env.MTNODE_NO_BROWSER = '1'
  else delete env.MTNODE_NO_BROWSER
  /* 规范名单（已排序去重）：空值必须显式 delete —— env 是从本进程 process.env 拷来的，
     留着上一次的脏值会让「这一轮不裁任何工具」变成「继续裁」。 */
  if (hiddenEnv) env[HIDE_TOOLS_ENV] = hiddenEnv
  else delete env[HIDE_TOOLS_ENV]
  /* 用户工具描述子（工具节点 func call）：tools-plugin.mjs 在 spawn 时按它注册。
     pure 运行由 handleRun 预先裁空（toolsJson === ''），此处无需再判 pure。 */
  if (toolsJson) env.MTNODE_TOOLS_JSON = toolsJson
  else delete env.MTNODE_TOOLS_JSON
  if (envPatch) Object.assign(env, envPatch)

  /* 占用登记:放在本函数第一个 await 之前(同步完成),否则并发 run 会挑中同一台
     runtime —— 那正是「停一个会话把别的会话一起打断」的根因。
     runSession 一并登记:交互桥帧的归属从这一刻起就有判据了。 */
  const tag = claimRuntime(key, reqId, cancelTag, runSession, hostSessionId)

  /* 交互桥:每个运行时独占一个 localhost 端口。bridge + canvas 插件各连一条
     socket,按帧上的 id 把回答写回对应连接。 */
  const bridgeState = { server: null, sockets: new Set() }
  /* 语音通道的令牌：这只 TCP 服务同时收「交互桥」与「语音面」两类连接，靠插件在 connect
     后发的第一帧（{t:'speech-hello', token}）区分，令牌对不上的一律按交互桥处理（老行为）。
     令牌随 spawn 注入 MTNODE_SPEECH_TOKEN，只在本机回环上出现。 */
  const speechToken = crypto.randomUUID()
  const bridgePort = await new Promise((resolve, reject) => {
    const server = createServer((s) => {
      bridgeState.sockets.add(s)
      socketToKey.set(s, key)
      let buf = ''
      /* 这只 socket 是不是语音通道：null = 首帧未到（尚未判定） */
      let isSpeech = null
      s.on('data', (d) => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          let m
          try { m = JSON.parse(line) } catch { continue }
          /* 这条 socket 属于哪一侧：首帧是 {t:'speech-hello', token} 才算语音通道，
             其余一律按交互桥处理（老行为一字不变）。判定放在**路由之前**：语音插件保证
             先发 hello 再发别的（见 speech-plugin.mjs），所以这里不会把语音帧喂给交互桥。 */
          if (isSpeech === null && m && m.t === 'speech-hello') {
            const okTok = String(m.token || '') === speechToken
            isSpeech = okTok
            diag(`speech-hello token-match=${okTok}`)
            if (okTok) registerSpeechSocket(key, s)
            continue
          }
          if (isSpeech) {
            onSpeechFrame(key, m, s)
            continue
          }
          if (isSpeech === null) isSpeech = false
          /* 逐帧兜底:net socket 的 data 回调里抛出任何异常都没有人接管 —— 整个网关进程当场
             退出(此前这里引用了一个已被改名删掉的变量,一投交互帧 ReferenceError 掀翻全仓
             AI,且只在下次请求时才懒重启)。单帧出错只 abort 它自己那一条交互并留痕,
             桥与其余帧继续。 */
          try {
            onBridgeFrame(key, m, s)
          } catch (err) {
            try {
              if (m && typeof m.id === 'string') s.write(JSON.stringify({ t: 'abort', id: m.id }) + '\n')
            } catch {}
            const where = String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')
            diag(`frame-error t=${(m && m.t) || '(无)'} id=${(m && m.id) || '(无)'} ${where}`)
          }
        }
      })
      s.on('error', () => {})
      s.on('close', () => {
        bridgeState.sockets.delete(s)
        socketToKey.delete(s)
        if (isSpeech) unregisterSpeechSocket(key, s)
        else abortBridgePending(key, s)
      })
    })
    server.on('error', (err) => {
      /* 端口没起来 = 这台 runtime 不存在:先退订,否则该 key 永久「在途」 */
      releaseClaim(key, reqId, tag)
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      bridgeState.server = server
      resolve(server.address().port)
    })
  }).catch((err) => {
    /* 建桥失败 = 本次运行没起起来:释放占用,否则该 key 永远「被占用」,后续 run 全被推去另起进程 */
    releaseClaim(key, reqId, tag)
    throw err
  })
  env.MTNODE_BRIDGE_PORT = String(bridgePort)
  /* 语音通道：复用上面同一只回环 TCP 服务，端口与令牌一起注入（见 speech-plugin.mjs）。
     端口缺席 = 运行时那侧整体 no-op；pure 档不挂语音行，令牌也照样下发（无害）。 */
  env.MTNODE_SPEECH_PORT = String(bridgePort)
  env.MTNODE_SPEECH_TOKEN = speechToken
  speechRuntimes.set(key, { port: bridgePort, token: speechToken })
  /* 思考强度生效档:经 env 下达给运行时 mtnode-effort 插件(在 agent/request waterfall
     上逐步把档位提案进模型请求)。settings.yaml 的 llm-deepseek.reasoningEffort 只留
     兜底默认(见 applySettings),档位切换只冷起新 runtime(档位在 runtime key 里),
     不再触发 settings 热重载。effort 参数由 handleRun 传入归一后的 runEffort。 */
  if (effort) env.MTNODE_EFFORT = String(effort)
  else delete env.MTNODE_EFFORT
  bridgeServers.set(key, bridgeState)

  try { linkUserPackagesIntoGateway() } catch { /* best-effort */ }

  const entry = { order: ++runtimeOrder }
  /* 宿主托管设置叠加层（applySettings 每次运行前整份重写；不存在 = 不是本机首跑的
     托管路径，照样能起运行时）。 */
  const settingsOverlay = home && existsSync(managedSettingsPatchPath(home)) ? managedSettingsPatchPath(home) : ''
  entry.harness = (async () => {
    const harness = new DeepSeekHarness({
      /* 0.2 launcher：profile + patch。cordis.yml 是叠加在内置 sdk profile
         （@deepseek-ai/dsh-base + @deepseek-ai/dsh-sdk-app 两层）之上的 MTNode 补丁层；
         bin 由 SDK 解析自己同版本的 @deepseek-ai/dsh（版本不一致会显式报错）。
         patches 的顺序 = 层序：cordis.yml（MTNode 组合）在前，宿主托管设置叠加层在后
         （applySettings 每次运行前整份重写，见 writeManagedSettingsPatch），
         用户自己的补丁在 profile 目录里、由运行时自己最后应用。 */
      profile: 'sdk',
      ...(RUNTIME_BIN ? { dshBin: RUNTIME_BIN } : {}),
      /* 握手预算（默认只有 10s，见 INITIALIZE_TIMEOUT_MS） */
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
      patches: [
        CORDIS_PATH,
        ...(settingsOverlay ? [settingsOverlay] : []),
      ],
      cwd: workspace,
      processCwd: workspace,
      env,
      provider,
      model,
      maxTokens: effMaxTokens,
    })
    await warmStartHarness(harness)
    return harness
  })().catch((err) => {
    runtimes.delete(key)
    releaseClaim(key, reqId, tag)
    throw err
  })
  runtimes.set(key, entry)

  while (runtimes.size > MAX_RUNTIMES) {
    let oldestKey = null
    let oldestOrder = Infinity
    for (const [k, v] of runtimes) {
      if (k === key) continue
      /* 有在途 req 的 runtime 不可回收，否则会中断全局助手/画布桥 */
      if (keyToReqId.has(k)) continue
      /* 续跑候选豁免:失败轮进程要留给宿主重发窗口的续跑轮点名复用 —— LRU 换出
         = 换进程 = 续跑接不上 → 整轮重发白烧,候选不参与 LRU 淘汰(resumeCandidateOf
         顺带清掉已过期的死标记,不占豁免名额) */
      if (resumeCandidateOf(k)) continue
      if (v.order < oldestOrder) {
        oldestOrder = v.order
        oldestKey = k
      }
    }
    if (!oldestKey) break
    const evicted = runtimes.get(oldestKey)
    runtimes.delete(oldestKey)
    resumeCandidates.delete(oldestKey)
    closeBridge(oldestKey)
    forgetKey(oldestKey)
    void evicted.harness.then((h) => h.close()).catch(() => {})
  }
  return { harness: entry.harness, key, fresh: true }
}

/* mtnode-bridge 帧路由:挂起 → 转发给对应 run 的渲染层事件 */
/* ── 语音通道的实现（mtnode-speech）──────────────────────────────────────
   三类角色：
     · 渲染层 → 网关（本地协议方法 `speech`）：state / prepare / cancel / transcribe；
     · 网关 → 运行时（这条回环 socket）：同样的 action 加一枚 id；
     · 运行时 → 网关的主动帧（speech-state）：准备状态变化，转成宿主事件 `speech-state`。
   没有在途 run 时也要能用：speech 方法会按需把这台 workspace 的运行时拉起来
   （buildRuntime 幂等，key 相同即复用）。 */

/** 语音 socket 连上时登记 */
function registerSpeechSocket(key, socket) {
  const prev = speechSockets.get(key)
  if (prev && prev !== socket && !prev.destroyed) {
    /* 一台运行时只留最新一条语音连接：旧连接（重连竞态）直接收掉，避免结果回到死 socket */
    try { prev.destroy() } catch {}
  }
  speechSockets.set(key, socket)
  speechSocketKey.set(socket, key)
  diag(`speech channel up key=${key}`)
}

/** 语音 socket 断开时清理在途请求 */
function unregisterSpeechSocket(key, socket) {
  if (speechSockets.get(key) === socket) speechSockets.delete(key)
  speechSocketKey.delete(socket)
  for (const [id, p] of speechPending) {
    if (p.key !== key) continue
    speechPending.delete(id)
    p.reject(new Error('语音通道已断开（运行时可能刚重启，请重试）'))
  }
}

/** 运行时 → 网关的语音帧 */
function onSpeechFrame(key, m, socket) {
  if (!m || typeof m.t !== 'string') return
  if (m.t === 'speech-ok' || m.t === 'speech-err') {
    const p = typeof m.id === 'string' ? speechPending.get(m.id) : null
    if (!p) return
    speechPending.delete(m.id)
    if (m.t === 'speech-ok') p.resolve(m.result)
    else p.reject(new Error(String(m.error || '语音操作失败')))
    return
  }
  if (m.t === 'speech-state') {
    /* 准备状态变化（下载进度 / 已就绪 / 失败）：推给渲染层。没有 reqId —— 它不是某一轮
       的产物，宿主按 type 分发即可（与 browser-act 同类）。 */
    out({ event: { reqId: '', type: 'speech-state', data: { state: m.state || {} } } })
    return
  }
  void socket
}

/**
 * 往某台运行时的语音通道发一条请求。
 * @param {string} key - runtime key
 * @param {object} payload - {action, …}
 * @param {number} timeoutMs - 超时（下载/转写都要留足）
 * @returns {Promise<any>} 运行时回的结果
 */
function speechRequest(key, payload, timeoutMs) {
  const socket = speechSockets.get(key)
  if (!socket || socket.destroyed) {
    return Promise.reject(new Error('语音通道未就绪（运行时刚起来时请稍等一两秒再试）'))
  }
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      speechPending.delete(id)
      reject(new Error(`语音操作超时（${payload.action}）`))
    }, timeoutMs)
    speechPending.set(id, {
      key,
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      socket.write(JSON.stringify({ t: 'speech', id, ...payload }) + '\n')
    } catch (err) {
      clearTimeout(timer)
      speechPending.delete(id)
      reject(err)
    }
  })
}

/**
 * 本地协议方法 `speech`：语音输入的宿主面。
 * { workspace, action:'state'|'prepare'|'cancel'|'transcribe', providerId?, downloadSource?,
 *   language?, audio? (base64 WAV 16kHz 单声道 PCM16) }
 * @param {object} params
 * @returns {Promise<object>} 运行时结果；失败抛错（调用方转成 {ok:false,error}）
 */
async function handleSpeech(params) {
  const p = params && typeof params === 'object' ? params : {}
  const action = String(p.action || 'state')
  const workspace = String(p.workspace || p.cwd || '').trim()
  if (!workspace) throw new Error('缺少 workspace：语音输入要绑定一台工作区运行时')
  /* 语音运行时是一台**专用档**（key 里带 voice 标记）：它与「某一轮 run」无关，也不该
     被某轮的取消 / 换档带着走 —— 复用同一台的话，一次语音请求可能撞进用户正在跑的会话。
     key 只由 workspace 决定，同一张画布反复录音始终复用同一台（模型 / 密钥都为空，
     识别在 CPU 上跑，不碰用户的服务商配置）。 */
  let voiceKey = pickRuntimeKey(
    runtimeKey(workspace, '', 0, 'voice', '', '', '|voice', ''),
    'speech'
  )
  /* 运行时不在池里就先拉起来（幂等）：用户点录音时可能这台画布还没跑过任何一轮。
     插件建连时是按**被拉起的那台**登记的，所以拉起后用它回报的 key 去找通道
     （pickRuntimeKey 在「有在途 run 占着同一个 baseKey」时会派生出 ##speech 变体，
     事先算出的 voiceKey 就不一定是最终那台）。 */
  if (!speechSockets.has(voiceKey)) {
    const rt = await getRuntime(
      workspace, undefined, undefined, undefined, undefined, undefined, '', undefined, undefined,
      undefined, undefined, 'speech', '', false, '', '', '', false, false, undefined, false,
    )
    if (rt && rt.key) voiceKey = rt.key
  }
  /* 通道刚建好时插件那侧还在建连（插件 connect 是同步发起的，握手要到下一个 tick），
     这里等到「socket 登记」或超时，避免第一下点录音必然报「未就绪」。 */
  const deadline = Date.now() + 8000
  while (!speechSockets.has(voiceKey) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120))
  }
  const timeout = action === 'prepare' ? 10 * 60 * 1000 : action === 'transcribe' ? 3 * 60 * 1000 : 30 * 1000
  return speechRequest(
    voiceKey,
    {
      action,
      ...(p.providerId ? { providerId: String(p.providerId) } : {}),
      ...(p.downloadSource ? { downloadSource: String(p.downloadSource) } : {}),
      ...(p.language ? { language: String(p.language) } : {}),
      ...(p.audio ? { audio: String(p.audio) } : {}),
    },
    timeout
  )
}

function onBridgeFrame(key, m, socket) {
  if (!m || typeof m !== 'object') return
  if (typeof m.id !== 'string') return
  if (m.t === 'drop') {
    bridgePending.delete(m.id)
    /* 运行时已放弃这条交互(提问被中止 / 审批被取消):光删 pending 会让卡片留在界面上
       变幽灵。无条件推 ix-drop,渲染层据此撤卡;没有在途 run 时 reqId 为空,
       渲染层按 id 全局兜底撤卡。老渲染层忽略未知事件类型,不影响既有链路。 */
    const claim = claimOf(key)
    out({ event: { reqId: claim ? claim.reqId : '', type: 'ix-drop', data: { id: m.id, reason: 'dropped' } } })
    return
  }
  if (m.t !== 'question' && m.t !== 'approval' && m.t !== 'canvas' && m.t !== 'db' && m.t !== 'facts' && m.t !== 'tool' && m.t !== 'lt' && m.t !== 'asset' && m.t !== 'browser') return
  const claim = claimOf(key)
  /* 归属校验:交互帧一律自带发起轮的 session id(question/approval 来自 bridge-plugin,
     canvas/db 来自 canvas-plugin/db-plugin、facts 来自 ai-facts-plugin(MTNode AI 事实库)、
     tool 来自 tools-plugin 的 exec agent),
     网关据此判定「这帧属不属于此刻在跑的这一轮」。与本轮对不上 = 预热轮('ok')在问话,
     或上一轮遗留的后台 job / 子代理现在才醒过来发起交互。这类帧一旦弹进当前会话就是
     死框(答案送回一个没人听的 session,点了毫无反应),所以直接 abort:运行时侧那个
     工具以失败收场,模型继续往下走。画布/数据库/工具帧绝不盲目执行 —— 这正是
     「跑着跑着多出一个确认框、回答后执行无效」的成因,现在同规矩处理。
     不带 sessionId 的帧同样按越权处理(fail closed)——归属不明的交互不该出现在任何会话里。 */
  const sid = typeof m.sessionId === 'string' ? m.sessionId : ''
  if (!claim || !claim.reqId) {
    rejectBridgeFrame(key, claim, m, socket, sid)
    return
  }
  if (!sid || !claim.sessions.has(sid)) {
    rejectBridgeFrame(key, claim, m, socket, sid)
    return
  }
  /* 浏览器帧（browser_* 工具面）：与 canvas / db 同源 —— 同样要过归属门控（上面两道），
     同样不进 bridgePending（它自己的问答用 BrowserCtl.ask，不占通用交互 id 空间）。
     区别只在「谁执行」：画布帧转给渲染层执行，浏览器帧由网关进程内的 browser-host
     直接驱动本机 Edge/Chrome（CDP），并把结果原路回给运行时插件。 */
  if (m.t === 'browser') {
    void handleBrowserFrame(key, m, socket)
    return
  }
  bridgePending.set(m.id, { socket, key, kind: m.t, reqId: claim.reqId, sessionId: sid })
  const data = { id: m.id, sessionId: sid }
  if (m.t === 'question') data.questions = Array.isArray(m.questions) ? m.questions : []
  else if (m.t === 'approval') {
    data.toolName = m.toolName || ''
    if (m.callId !== undefined) data.callId = m.callId
    if (m.reason !== undefined) data.reason = m.reason
  } else if (m.t === 'tool') {
    /* 用户工具节点 func call：tool = 描述子定位（key/toolName/name），args = 模型入参 */
    data.tool = m.tool && typeof m.tool === 'object' ? m.tool : {}
    data.args = m.args && typeof m.args === 'object' ? m.args : {}
  } else {
    data.op = typeof m.op === 'string' ? m.op : ''
    if (typeof m.action === 'string') data.action = m.action
    data.params = m.params && typeof m.params === 'object' ? m.params : {}
  }
  /* tool 帧的本地协议事件叫 tool-run：与 mapNotification 的 tool（工具调用展示）不重名 */
  out({ event: { reqId: claim.reqId, type: m.t === 'tool' ? 'tool-run' : m.t, data } })
}

/* 浏览器帧的执行：跑在网关进程里（browser-host.mjs），结果/错误原路回插件。
   任何失败都只折算成这一条工具调用的失败回执（ok:false + error 文本），
   绝不让浏览器问题把会话跑挂 —— 与画布 / 数据库 / 素材同一口径。 */
async function handleBrowserFrame(key, m, socket) {
  const claim = claimOf(key)
  const reqId = claim ? claim.reqId : ''
  const reply = (obj) => {
    try { socket.write(JSON.stringify({ t: 'browser-result', id: m.id, ...obj }) + '\n') } catch { /* 桥已断 */ }
  }
  const started = Date.now()
  try {
    const r = await BrowserCtl.handle(key, m)
    reply({ ok: r.ok !== false, result: r.result == null ? { ok: true } : r.result })
  } catch (e) {
    const msg = String((e && e.message) || e)
    reply({ ok: false, error: msg })
    console.error(`[browser] op=${String(m && m.op)} failed: ${msg}`)
  } finally {
    /* 浏览器动作也进活动流（工具层摘要）：与 browser-host 自己的留痕互补 ——
       一条是「操作了什么」，这条是「这次调用成没成、花了多久」。 */
    try {
      BrowserCtl.push({
        at: started,
        kind: 'tool',
        text: `browser_${String(m && m.op || '')}${Date.now() - started > 1200 ? ' · ' + Math.round((Date.now() - started) / 1000) + 's' : ''}`,
      })
    } catch {}
  }
}

/* 工具「准备态」累计器（本次需求 · 会话可视化对齐上游 dsh 0.2.0-rc.2）：
   上游把 assistant/chunk 的 `tool-call-delta`（工具参数逐块流入的那一段）渲染成
   「正在准备内容 N KB」的一行不可展开卡片（dsh-client-ui-tool 的 preparing 阶段）。
   这里按 callId 累计 argumentsDelta 的字符数并限频下发 tool-preparing，
   真实 tool/call 到达时清账（卡片就此转入「运行中」）。
   只记两个数字 + 工具名：完整参数一个字符都不在这里攒（那是 tool/call 的事）。 */
const toolPrepAcc = new Map()
const TOOL_PREP_MIN_GAP_MS = 120
const TOOL_PREP_MAX_CALLS = 64

/* 已经收到过**原生** assistant/chunk 增量帧的 (turn,step)：该步的完整 assistant/message
   不再由 stream 合成增量（跨版本不双发）。原生 chunk 一律带 (turn,step)，这里只按它记；
   完整消息那一侧另用带内容指纹的键，就能同时容纳「同一步里多条完整消息」。 */
const chunkSeen = new Set()
/* 合成幂等键 = (turn,step) + 这条消息的内容指纹（正文总长 / 思考总长 / stream 条数）。
   为什么必须带指纹：实测**同一个 (turn,step) 会先后出现不止一条 assistant/message**
   （工具调用轮次里就是「先一条 reasoning + tool-call、文本为空，再一条 reasoning + 正文」，
   两条 turn/step 完全相同）—— 只按 (turn,step) 记，第二条的思考与正文就整段不会合成，
   正好又退回「思考不显示」。指纹让「同一条消息重复到达」判等（幂等），
   「两条不同消息」判不等（都要发）。 */
function chunkSeenKey(d) {
  const x = d || {}
  const msg = x.message || {}
  const blocks = Array.isArray(msg.content) ? msg.content : []
  let text = ''
  let rlen = 0
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') text += String(b.text == null ? '' : b.text)
    else if (b.type === 'reasoning') rlen += String(b.text == null ? '' : b.text).length
  }
  const stream = Array.isArray(x.stream) ? x.stream.length : 0
  return String(x.turn == null ? 0 : x.turn) + ':' + String(x.step == null ? 0 : x.step) +
    ':' + text.length + ':' + rlen + ':' + stream
}

/* 会话「思考 / 正文」增量的第二来源：完整的 assistant/message 里带的 stream 回放数据。
   —— 为什么必须有它（本 bug 的真根因，别再当成渲染层问题）：
   dsh 0.2 的运行时**不再向前端发 `assistant/chunk` 增量帧**（实测：连发 60 个会话日志
   里 `assistant/chunk` 出现 0 次；每个 step 只有一条完整的 `assistant/message`），
   而上面 mapNotification 的 assistant/chunk 分支正是 reasoning / text / tool-preparing
   三类帧的唯一出口 —— 于是运行时明明思考了（message.content 里 reasoning 块有真文本），
   宿主与渲染层一个字的思考增量都收不到：会话里既没有思考块，正文也不逐字出现
   （只有 tool / tool-result 帧照常，卡片看起来是好的）。
   0.2 把流式数据挪进了完整消息的 `stream` 字段：逐块 text 数组 + 每块之间的 dt 毫秒
   数组，足以按原节奏复现这一次生成。本函数就做这件事：把 stream 还原成与
   assistant/chunk 分支**完全同形**的帧（reasoning / text / say-end / tool-preparing）。
   节奏：**默认 instant**（一条不延时地连发）。实测这条 assistant/message 是**生成完毕
   之后**才到的（同一步里没有更早的同名事件），所以立刻连发就是「轮到就显示」，既不
   假装逐字、也不白白多等一轮生成时间；想要逐字观感可以开
   `MTNODE_STREAM_REPLAY=paced`（按 dt 限幅重放，用同步 sleep 保持 emit 顺序）。
   跨版本兼容：
     · 老运行时确实发 assistant/chunk → 该 (turn,step) 已登记，这里整步跳过（不双发）；
     · 没有 stream（老网关 / 非流式生成）→ 不发增量，行为与接入前一致；
     · 任何异常 → 一条帧都不发，只留一行日志，绝不影响这一轮收尾。
   开关：env MTNODE_STREAM_REPLAY = `paced`（按 dt 重放）/ `0` / `off` / `false`（整关），
   其余值 / 缺席 = instant。 */
const STREAM_REPLAY_MAX_MS = 60
const STREAM_REPLAY_BUDGET_MS = 20000
function streamReplayDelay() {
  try {
    const raw = String(process.env.MTNODE_STREAM_REPLAY || '').trim().toLowerCase()
    if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return -1
    if (raw === 'paced' || raw === 'pace' || raw === 'dt') return STREAM_REPLAY_MAX_MS
    return 0
  } catch { return 0 }
}
/* 同步小睡（毫秒）：paced 档用它保持 emit 顺序 —— mapNotification 是同步函数，
   用 await 会把帧序打乱（后一步的帧可能插到这一步前面）。 */
function streamReplaySleep(ms) {
  if (!(ms > 0)) return
  try {
    const buf = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buf), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* 退化自旋：只在 paced 档且 Atomics 不可用时发生 */ }
  }
}
function synthesizeChunksFromStream(p, emit, seen) {
  const arr = p && p.stream
  if (!Array.isArray(arr) || !arr.length) return
  /* 该 (turn,step) 已收到过原生增量帧 → 一条都不合成（跨版本不双发）。
     调用方也判了一次；这里再判一次是为了让函数自身就是幂等的（被别处复用时不会出错）。 */
  if (seen && seen.has(chunkSeenKey(p))) return
  const cap = streamReplayDelay()
  if (cap < 0) return
  /* 以完整消息的 content 为准（同一份数据，content 是权威形态） */
  const blocks = (p.message && Array.isArray(p.message.content)) ? p.message.content : []
  const turn = Number(p.turn) || 0
  const step = Number(p.step) || 0
  const textIdx = new Set()
  blocks.forEach((b, i) => {
    if (b && b.type === 'text') textIdx.add(b.index != null ? Number(b.index) : i)
  })
  /* stream 条目 → 与 assistant/chunk 同形的帧序列 */
  const frames = []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'reasoning-chunks' || s.type === 'text-chunks') {
      const kind = s.type === 'reasoning-chunks' ? 'reasoning' : 'text'
      const texts = Array.isArray(s.texts) ? s.texts : []
      const dtms = Array.isArray(s.dt) ? s.dt : []
      for (let i = 0; i < texts.length; i++) {
        const text = String(texts[i] == null ? '' : texts[i])
        const d = Number(dtms[i])
        frames.push({ type: kind + '-delta', index: s.index, text, wait: Number.isFinite(d) && d > 0 ? d : 0 })
      }
      continue
    }
    if (s.type !== 'chunk' || !s.chunk) continue
    const c = s.chunk
    if (c.type === 'block-end') {
      /* 正文块收尾 → say-end（与原生分支同一判据）。块序号对不上 content 时按
         「最后一个正文块」兜底，宁可多收一次尾，也不让正文段永远定不了稿。 */
      const idx = c.index != null ? Number(c.index) : -1
      if (idx < 0 ? textIdx.size > 0 : textIdx.has(idx))
        frames.push({ type: 'say-end', index: idx, wait: 0 })
    } else if (c.type === 'tool-call-delta') {
      const cid = String(c.id == null ? (c.callId == null ? '' : c.callId) : c.id)
      if (cid)
        frames.push({
          type: 'tool-call-delta',
          index: c.index,
          callId: cid,
          name: c.name || '',
          argumentsDelta: String(c.argumentsDelta == null ? '' : c.argumentsDelta),
          wait: 0,
        })
    }
  }
  let waited = 0
  let emitted = 0
  for (const f of frames) {
    if (f.wait > 0 && cap > 0 && waited < STREAM_REPLAY_BUDGET_MS) {
      const slice = Math.min(f.wait, cap, STREAM_REPLAY_BUDGET_MS - waited)
      waited += slice
      streamReplaySleep(slice)
    }
    const meta = { turn, step, index: f.index == null ? 0 : f.index }
    if (f.type === 'reasoning-delta') {
      if (f.text) { emit('reasoning', { text: f.text, ...meta }); emitted++ }
    } else if (f.type === 'text-delta') {
      if (f.text) { emit('text', { text: f.text, ...meta }); emitted++ }
    } else if (f.type === 'say-end') {
      emit('say-end', { ...meta }); emitted++
    } else if (f.type === 'tool-call-delta') {
      try {
        const cur = toolPrepAcc.get(f.callId) || { bytes: 0, name: '', at: 0 }
        cur.bytes += f.argumentsDelta.length
        if (f.name) cur.name = String(f.name)
        const now = Date.now()
        if (now - cur.at >= TOOL_PREP_MIN_GAP_MS) {
          cur.at = now
          if (toolPrepAcc.size < TOOL_PREP_MAX_CALLS || toolPrepAcc.has(f.callId))
            toolPrepAcc.set(f.callId, cur)
          emit('tool-preparing', { callId: f.callId, name: cur.name, bytes: cur.bytes, ...meta })
          emitted++
        } else if (toolPrepAcc.size < TOOL_PREP_MAX_CALLS || toolPrepAcc.has(f.callId)) {
          toolPrepAcc.set(f.callId, cur)
        }
      } catch { /* 准备态只是提示，任何异常都不影响这一轮 */ }
    }
  }
  if (emitted) diag(`assistant/message 合成增量帧 turn=${turn} step=${step} frames=${emitted} 等待=${waited}ms`)
  return emitted
}

/* 单次模型调用的用量记账（token 累计 + 逐模型台账 + 时间样本 + usage 帧）。
   为什么必须抽成函数：dsh 0.2 的 usage **不再走 assistant/chunk**（实测 0.2 会话日志里
   `assistant/chunk` 出现 0 次，usage 挂在完整 `assistant/message` 的 `data.usage` 上，
   形如 {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}），
   于是 handleRun 的统计分支一条账都记不到：metrics 全是 0 → 会话里「上下文已用 0 / 1.0M tok」、
   会话末尾的 Token 报告一个数都没有（本次需求要修的就是这个）。
   两个来源（chunk 的 c.usage / message 的 data.usage）在 0.2 里互斥：原生 chunk 上不再带
   usage，所以同一次调用只会经过这里一次，不存在双计。老运行时照旧走 chunk 那一支。 */
function accountUsage(metrics, u, t) {
  const stepStart = Number(metrics.stepStart) || 0
  const stepTtft = Number(metrics.stepTtft) || 0
  const stepMs = stepStart ? t - stepStart : 0
  const bucket = metrics.modelBucket()
  metrics.stats.inputTokens += u.inputTokens
  metrics.stats.outputTokens += u.outputTokens
  metrics.stats.cacheReadTokens += u.cacheReadTokens
  metrics.stats.cacheWriteTokens += u.cacheWriteTokens
  metrics.stats.reasoningTokens += u.reasoningTokens
  bucket.inputTokens += u.inputTokens
  bucket.outputTokens += u.outputTokens
  bucket.cacheReadTokens += u.cacheReadTokens
  bucket.cacheWriteTokens += u.cacheWriteTokens
  bucket.reasoningTokens += u.reasoningTokens
  bucket.calls++
  metrics.stats.llmMs += stepMs
  bucket.llmMs += stepMs
  /* 逐模型性能:TTFT 累计(本步采样值)+ 本次调用的预处理量(计费输入),
     genMs = 本次 LLM 用时扣掉首 Token 等待 = 纯生成时间 */
  if (stepTtft > 0) {
    bucket.ttftMs += stepTtft
    bucket.ttftSamples++
  }
  bucket.prefillTokens += u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  bucket.genMs += Math.max(0, stepMs - stepTtft)
  /* 逐次调用用量带模型归属下发:会话末尾的累计报告 Badge 靠它实时增长 */
  metrics.emit('usage', Object.assign({}, u, {
    provider: bucket.provider,
    model: bucket.model,
    at: t,
  }))
}

function mapNotification(n, emit, resumeCtx) {
  /* 活动流条目的归属会话：本轮 run 的宿主(渲染层)会话 id（缺省空串 = 本轮没有归属会话，
     面板就不会把这条算到某条会话头上）。工具 / 命令 / 文件摘要都按它盖章。 */
  const actSession = String((resumeCtx && resumeCtx.host) || '')
  if (n.method === 'session.event') {
    const ev = n.params.event
    if (!ev) return
    switch (ev.type) {
      case 'assistant/message': {
        /* dsh 0.2：增量帧缺席，流式数据骑在这条完整消息的 stream 字段上 —— 在这里把它
           还原成 reasoning / text / say-end / tool-preparing 帧（见 synthesizeChunksFromStream
           的文件头注释：不还原 = 会话里永远看不到思考与逐字输出）。
           该 (turn,step) 已收到过原生 chunk 时整步跳过（跨版本不双发）。
           注意用 break 不用 return：本函数末尾还有「原始事件透传」那一帧。 */
        try {
          if (!chunkSeen.has(chunkSeenKey(ev.data))) synthesizeChunksFromStream(ev.data, emit, chunkSeen)
        } catch (e) {
          diag(`assistant/message 合成增量失败（这一轮照常收尾）：${String((e && e.message) || e)}`)
        }
        break
      }
      case 'assistant/chunk': {
        const c = ev.data && ev.data.chunk
        if (!c) return
        /* 这个 (turn,step) 上真收到了原生增量块 → 该步的 assistant/message 不再由 stream 合成
           （见 synthesizeChunksFromStream），避免同一段文字被发两遍。 */
        chunkSeen.add(chunkSeenKey(ev.data))
        /* turn/step 实测在 ev.data 这一层(真实 session.jsonl:
           {type:'assistant/chunk', data:{turn:1, step:6, chunk:{…}}}),不在事件顶层;
           少数适配器会把它们放到事件顶层或 chunk 上,故 data → 顶层 → chunk 逐级回落。
           index 是内容块在该步内的序号。带上它们前端才能把一次回答切成段,
           并让思考流与正文流各自归位。老渲染层忽略新字段即可,语义不变。 */
        const ed = ev.data || {}
        const meta = {
          turn: ed.turn ?? ev.turn ?? c.turn ?? 0,
          step: ed.step ?? ev.step ?? c.step ?? 0,
          index: c.index ?? ev.index ?? 0,
        }
        if (c.type === 'reasoning-delta' && c.text) emit('reasoning', { text: c.text, ...meta })
        else if (c.type === 'text-delta' && c.text) emit('text', { text: c.text, ...meta })
        else if (c.type === 'tool-call-delta') {
          /* 工具参数增量（见 toolPrepAcc 注释）：限频下发「已准备多少字节」。
             上游口径是 Math.ceil(raw.length / 1024) → N KB，故这里只累计字符数。 */
          const cid = String(c.id == null ? '' : c.id)
          if (cid) {
            try {
              const cur = toolPrepAcc.get(cid) || { bytes: 0, name: '', at: 0 }
              cur.bytes += String(c.argumentsDelta == null ? '' : c.argumentsDelta).length
              if (c.name) cur.name = String(c.name)
              const now = Date.now()
              if (now - cur.at >= TOOL_PREP_MIN_GAP_MS) {
                cur.at = now
                if (toolPrepAcc.size < TOOL_PREP_MAX_CALLS || toolPrepAcc.has(cid))
                  toolPrepAcc.set(cid, cur)
                emit('tool-preparing', {
                  callId: cid,
                  name: cur.name,
                  bytes: cur.bytes,
                  ...meta,
                })
              } else if (toolPrepAcc.size < TOOL_PREP_MAX_CALLS || toolPrepAcc.has(cid)) {
                toolPrepAcc.set(cid, cur)
              }
            } catch { /* 准备态只是提示，任何异常都不影响本轮 */ }
          }
        }
        else if (c.type === 'block-end') {
          /* 正文块收尾 → say-end,前端据此切段(一个 turn/step/index 一段)。
             思考块 / 工具块收尾不发,事件名与新字段都不动老语义。 */
          const blk = c.block || (ev.data && ev.data.block) || {}
          if ((blk.type || c.blockType) === 'text') emit('say-end', { ...meta })
        }
        /* usage 不在此处上报:handleRun 的统计分支会带上 provider/model 归属后再 emit,
           否则客户端无法按模型分别累计 token。
           注意这里是 break 而不是 return：本函数末尾还有一帧「原始事件透传」
           （session-event，见文件末尾），提前 return 会让 assistant/chunk 整帧到不了前端。 */
        break
      }
      case 'tool/call': {
        const d = ev.data
        if (d) {
          /* 准备态到此结束：真实调用已就位，卡片转入「运行中」（清掉累计器） */
          try { toolPrepAcc.delete(String(d.callId == null ? '' : d.callId)) } catch {}
          /* 活动流：命令 / 工具的调用摘要（用户已确认「浏览器动作 + shell 命令 + 文件读写
             摘要都进活动流」）。这里只记工具名与一小段入参摘要，完整输出由 tool/result
             再补一条 —— 都只进活动流与宿主落库，**不进模型上下文**。 */
          const nm = String(d.name ?? d.tool ?? '')
          if (nm && !/^mtnode_(canvas|app|facts|assets)|^lt_/.test(nm)) {
            try {
              const argText = summarizeToolArgs(d.arguments)
              BrowserCtl.push({ kind: nm.replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'tool', text: nm + (argText ? ' · ' + argText : ''), sessionId: actSession })
            } catch { /* 留痕失败绝不影响会话 */ }
          }
          emit('tool', {
            callId: d.callId ?? '',
            turn: d.turn ?? 0,
            step: d.step ?? 0,
            name: d.name ?? d.tool ?? '',
            args: d.arguments ?? null,
          })
        }
        return
      }
      case 'tool/result': {
        const d = ev.data
        if (!d) return
        /* ToolResultMessage.content 是单个 tool-result 块:外层只带相关性,
           真正的结果内容块与 toolCallId 都在其内层。 */
        let callId = ''
        let blocks = []
        const m = d.message
        if (m && Array.isArray(m.content) && m.content.length) {
          const first = m.content[0]
          if (first && first.type === 'tool-result') {
            callId = first.toolCallId || ''
            blocks = Array.isArray(first.content) ? first.content : []
          } else {
            blocks = m.content
          }
        }
        /* 结果内容块(text/terminal/diff…),截断防超长终端输出撑爆事件流 */
        const content = blocks.map((b) => {
          const o = { type: b && b.type ? String(b.type) : 'text' }
          if (b && typeof b.text === 'string')
            o.text = b.text.length > 32768 ? b.text.slice(0, 32768) + '\n…（已截断）' : b.text
          return o
        })
        emit('tool-result', {
          callId,
          turn: d.turn ?? 0,
          step: d.step ?? 0,
          content,
          error: d.error ?? null,
        })
        /* 活动流：这次调用的结果摘要（成功给前 300 字符，失败给错误文本） */
        try {
          const nm = String(d.name ?? d.tool ?? 'tool')
          const sum = summarizeToolOutput(content, d.error)
          if (sum && !/^mtnode_(canvas|app|facts|assets)|^lt_/.test(nm)) {
            BrowserCtl.push({ kind: 'tool-result', text: nm + ' → ' + sum, sessionId: actSession })
          }
        } catch { /* 留痕失败绝不影响会话 */ }
        return
      }
      case 'session/title':
        if (ev.data && ev.data.title) {
          /* 透传来源种类：渲染层需区分引擎 5 词回落(fallback) 与 LLM 真实主题(user/provider)，
             避免回落先占住 titleAuto 锁死真实主题。旧版渲染层忽略 source 字段、向后兼容。 */
          emit('title', {
            title: ev.data.title,
            source: (ev.data.source && ev.data.source.kind) || '',
          })
        }
        return
      case 'turn/end':
        /* 换轮 = 上一轮的准备态记账作废（没等到 tool/call 的调用不会跨轮留着） */
        try { toolPrepAcc.clear() } catch {}
        if (ev.data && ev.data.reason && ev.data.reason.kind === 'error') {
          const msg = ev.data.reason.error && ev.data.reason.error.message
          if (msg) {
            /* 续跑轮撞运行时侧 id collision：转译成 RESUME_UNAVAILABLE 契约（宿主据此
               退回整轮重发）。非续跑轮（resumeCtx 空）原样透传，保留现场。 */
            const conv =
              resumeCtx && resumeCtx.resumed
                ? resumeCollisionMessage(msg, resumeCtx.sid)
                : ''
            emit('error', { message: String(conv || msg).slice(0, 500) })
          }
        }
        return
      default:
        /* 全量透传其余会话事件(permission/preset、approval/* 等)。
           steer 的插话回流(再收到一条 agent/inbox/spliced)与 pause 的 aborted 收尾
           都落在这里:不新增事件名,宿主按 type 自行归类即可。 */
        emit('session-event', { type: ev.type, data: ev.data ?? {} })
        return
    }
  }
  if (n.method === 'session.status') {
    emit('status', { state: n.params.status ?? '' })
  }
}

async function handleRun(params) {
  const {
    reqId, workspace, input, model, maxTokens,
    apiKey, baseUrl, systemPrompt, preset, effort, provider, mtnodeProviders, dshHome,
    permissionPreset, webSearchApiKey, hostPersona, cancelTag, pure, tools,
    lean, noCanvas, hideTools, noBrowser,
    resumeSession, hostSessionId, officialModels: officialModelsRaw,
  } = params
  const emitOut = (type, data) => out({ event: { reqId, type, data } })
  /* 本轮在途登记的键(claimRuntime / emit('session') 按它建,finally 按它清);
     runPaused() = 宿主是否已对本轮下达 pause —— 暂停后的 aborted 收流不是失败。 */
  const runIdKey = String(reqId == null ? '' : reqId).trim()
  const runPaused = () => !!runIdKey && pausedRuns.has(runIdKey)
  /* 失败报文收集:通知流里报过的 error(message,如 turn/end reason error 的 429/5xx)
     与 catch 的 rawMessage 都收进来,finally 收尾时据此给失败轮 runtime 打
     「续跑候选」保活标记(见 markResumeCandidate)。只有 error 事件会写它,
     其余事件原样透传,语义不变。
     唯一的例外是已暂停的这一轮:pause 之后运行时把 turn 以 aborted 收尾,有的实现
     会把它报成 turn/end reason error —— 绝不能透给宿主(宿主的失败重发闸只看 error,
     会把一次「暂停」当 429 类失败连重发 5 次,见 pausedRuns),就地吞掉并留一行日志。 */
  let runErrorMsg = ''
  const emit = (type, data) => {
    if (type === 'error' && data && typeof data.message === 'string' && data.message) {
      if (runPaused()) {
        diag(`pause-swallow-error reqId=${runIdKey} msg=${data.message.slice(0, 120)}`)
        return undefined
      }
      runErrorMsg = data.message
    }
    return emitOut(type, data)
  }
  let runKey = ''
  /* 本轮以可重发错误失败时,收尾要打的保活报文(catch 的 rawMessage / 成功收流但
     中途报过错的 runErrorMsg);无失败或非重发类 = 空串,不打标 */
  let failForResume = ''
  /* 本次运行的取消标签:结束时只能清自己那条登记,别踩到同标签的下一轮 */
  const runTag = tagOf(cancelTag)
  /* 本轮「真实轮」的 dsh session id:由网关铸造并显式传给 harness.run,
     同时登记进 runtime 占用表,交互桥帧(question / approval)按它判归属。
     形如 SDK 自己铸的 `session-<uuid去横线>`,运行时按未知 id 新建会话,语义与从前一致
     (每轮一个新 session,预热轮也是各自一个),只是现在网关提前知道真实轮叫什么。
     断点续跑(宿主带 resumeSession):盘上文件判据(**第一道闸**,见 resumeSessionExists)
     通过才沿用它,否则照旧新铸 —— 运行时对未知 id 是「新建空会话」,静默续跑会让模型只
     看到一句「继续」而彻底跑偏,所以第一道闸不过时必须先把 RESUME_UNAVAILABLE 报给宿主
     (见下方分支),绝不带着假 session 起轮。文件在盘只是必要不充分:续跑轮在起真实轮前
     另有 session/resume 握手做跨进程盘上恢复(见下方「session/resume 桥」段),两者都
     不成才按 RESUME_UNAVAILABLE 契约收场(三态见 dsh/DESIGN.md「断点续跑契约」)。 */
  const resumeWanted = normSessionId(resumeSession)
  const canResume = !!resumeWanted && resumeSessionExists(dshHome, resumeWanted)
  const resumed = canResume
  const runSession = canResume
    ? resumeWanted
    : 'session-' + crypto.randomUUID().replaceAll('-', '')
  /* done / session 事件对宿主报告的权威 id:默认就是本轮铸(或沿用)的 runSession,
     首条 session.event 改判后跟着改(见 rebindRunSession 分支) */
  let sessionOut = runSession
  /* 续跑判定留一行日志:出问题时先看得懂「宿主点名的那个 id 到底在不在盘上」 */
  if (resumeWanted) diag(`resume reqId=${reqId || '(无)'} sid=${resumeWanted} can=${canResume ? 1 : 0}`)
  if (runTag) activeRunTags.add(runTag)
  /* 度量构建器在 try 内装配(需要 route/model 等),catch 里也要能记成本,故先声明 */
  let buildMetrics = null
  try {
    /* 宿主点名续跑,但该会话在本机不可续跑(id 非法 / 会话文件不存在,例如被设置面板的
       会话清理删掉、或 id 属于另一 workspace 的归档):立即以固定标记报错并收轮,
       不起 runtime、不消耗任何 token —— 宿主据此退回「整轮重发」。
       绝不允许静默降级成新 session:运行时对未知 id 是新建空会话,模型只看到一句
       「继续」会彻底跑偏,而宿主以为续上了。 */
    if (resumeWanted && !canResume) {
      emit('error', {
        message: `RESUME_UNAVAILABLE: 会话 ${resumeWanted} 在本机不可续跑（未找到 <dshHome>/sessions/*/${resumeWanted}/session.jsonl[.zstd]），请改为整轮重发`,
      })
      emit('done', { finalResponse: '', resumeUnavailable: true })
      return
    }
    if (!input || typeof input !== 'string' || !input.trim()) {
      emit('error', { message: '任务内容为空' })
      emit('done', { finalResponse: '' })
      return
    }
    const hostPersonaText = String(hostPersona || '').trim()
    /* 纯净模式「双清空」:宿主侧 systemPrompt 置空(app-assist.js / app-db.js 的 pure
       分支) + 网关侧强制空预设文本 —— 两段都为空,下面的 sys 才为空,用户消息原样
       直达模型,不拼【系统设定】前缀。引擎人设 / 运行时上下文由 pure-prompt 插件按
       MTNODE_PURE 标记整段清除(两侧缺一都会让提示词漏进纯净会话)。 */
    const pureFlag = !!pure
    /* 按运行裁剪工具负载（与 getRuntime 的 lean: / nc: 同源，同一轮同一台运行时）：
       lean = 设置里的「精简工具负载」；noCanvas = 画布智能节点（nodeLock）运行，
       由渲染层按节点类型决议后随 run 参数下发（见 renderer/app-db.js 的 dshRunOnce）。
       pure 轮画布 / 数据库等工具插件本就被 cordis 整体禁用，两个标记无意义 → 归零。 */
    const leanFlag = !!lean && !pureFlag
    const noCanvasFlag = !!noCanvas && !pureFlag
    /* 浏览器工具整档闸（与 getRuntime 的 nb: 同源）：仅会话可用 —— 画布智能节点 /
       用户声明「与画布无关」的会话 / 长任务未授权环节由宿主打这一位，
       运行时整只不注册 browser-plugin.mjs（含它的 12 个工具 schema）。 */
    const noBrowserFlag = !!noBrowser && !pureFlag
    /* 旧 id 归一(sketch → lean):预设文本按现名查表,否则历史会话会静默回落 standard */
    const presetId = normalizePresetId(preset)
    /* 目录同源服务商(如 opencode-go)映射回目录路由名,与 settings 注册一致 ——
       先定路由:思考档的归一化按路由能力表进行(deepseek-official 固定夹紧)。 */
    const route = routeOfProvider(provider, Array.isArray(mtnodeProviders) ? mtnodeProviders : [])
    /* 思考档一律沿用宿主设置(预设不压档)。归一化收敛在 reasoning-effort.mjs(codex
       reasoning_effort_for_request 式):off/none/无 → off(关闭思考)、空串 / 非法 → high;
       按路由能力夹紧(不支持 → 同侧最近低档 → high 兜底,永不硬失败;off 不支持则退回最近
       正档)。同一个 runEffort 三处共用:settings 只写兜底默认(见 applySettings)、
       runtime key(换档冷起新运行时)、env MTNODE_EFFORT(运行时 mtnode-effort 插件按模型
       能力再夹一次)。 */
    const rawEffort = String(effort ?? '').trim().toLowerCase()
    const runEffort = effortForRoute(rawEffort, route)
    const settings = applySettings(
      dshHome,
      runEffort,
      mtnodeProviders,
      permissionPreset,
      hostPersonaText,
      /* 官方模型清单(可选 run 参数):归一后写进 settings.yaml 的 llm-deepseek.models */
      normalizeOfficialModels(officialModelsRaw),
    )
    const cordisChanged = applyCordisPreset(permissionPreset)
    /* win32 闪窗 workaround:首次运行时把 sandbox 注入 noop runner */
    const sandboxChanged = applySandboxWorkaround()
    /* 设置文档热重载窗口:变更后稍候,确保首请求读到新档位 */
    if (settings.changed || cordisChanged || sandboxChanged) await new Promise((r) => setTimeout(r, 450))
    /* 生效档回传宿主(回显=下发契约):真实轮起跑前先发一次 run 事件 effort,
       宿主按它回显「用户选的档 → 该路由实际生效的档」。 */
    emit('effort', { requested: rawEffort, effort: runEffort, route })
    /* 空串预设(如 bongochat)必须保留,不能 || 回退成 MTNode standard;
       纯净模式(pure)强制空预设文本,不拼任何角色前缀 */
    const presetBase = pureFlag
      ? ''
      : (Object.prototype.hasOwnProperty.call(PRESETS, presetId) ? PRESETS[presetId] : PRESETS.standard)
    /* 本轮裁掉了工具 → 预设文本后补一句「这些工具不存在」（人设为空的轮次不补，
       见 LEAN_TOOLS_NOTE 注释：没有工具可裁的桌宠 / 纯净轮不该多出这一段） */
    const presetText = leanFlag && presetBase ? presetBase + LEAN_TOOLS_NOTE : presetBase
    /* 名单通道（hideTools）同样补一句：这些工具整份 schema 都不下发（MTNode 自有的不
       注册、引擎自带的由 restrict 摘除），而人设 / 技能里可能还写着它们。名单已由网关
       归一成规范串，同一档每轮逐字相同 → 这句话照样进得了稳定前缀，不会打爆缓存。 */
    const hiddenNames = pureFlag ? [] : normalizeHiddenTools(hideTools)
    const hiddenText =
      presetBase && hiddenNames.length
        ? '\n\n【本轮不注册的工具】' + hiddenNames.join(' / ') +
          '：这些工具在本轮不存在，调用即失败；缺少它们的能力请改用工具列表里还在的入口。'
        : ''
    const presetTextAll = presetText + hiddenText
    const sys = [presetTextAll, systemPrompt]
      .filter((s) => s && String(s).trim())
      .join('\n\n')
    /* 宿主人设已写入真正的 system-prompt,不再塞进用户消息以免被当成越权改角色。
       pure 时 sys 为空(双清空,见上),条件走 input 分支:消息里没有任何
       【系统设定】前缀,模型收到的就是用户原话。 */
    const prompt = sys && !hostPersonaText
      ? `【系统设定】\n${sys}\n\n【内容】\n${input}`
      : input
    /* 携带图像:把图像写入附件对象库,任务消息 = 文本块 + image 内容块 */
    const blocks = [{ type: 'text', text: prompt }]
    if (params.images && params.images.length) {
      const imgBlocks = await attachImages(dshHome || process.env.DSH_HOME || '', params.images)
      blocks.push(...imgBlocks)
    }
    /* 用户工具描述子（工具节点 func call）：pure 会话不注入（纯净模式只留联网搜索） */
    const runTools = pureFlag ? [] : normRunTools(tools)
    const toolsJson = runTools.length ? JSON.stringify(runTools) : ''
    const rt = await getRuntime(
      workspace, model, maxTokens, route, apiKey, baseUrl, dshHome, settings.envPatch, runEffort,
      webSearchApiKey, hostPersonaText, cancelTag, reqId, pureFlag, runSession, hostSessionId, toolsJson,
      leanFlag, noCanvasFlag, hideTools, noBrowserFlag,
    )
    runKey = rt.key
    /* 占用成功 = 本轮的 session 归属已经钉死,第一时间报给宿主。
       宿主只有拿到这个 id 才可能在崩溃/断线后点名续跑(resumeSession),所以必须在
       起真实轮之前、而不是等 done 才说;resumed 表示这是沿用上一轮的旧会话。
       运行时若自行另铸 id(版本漂移),首条 session.event 改判权威 id 时会再 emit 一次。 */
    emit('session', { sessionId: sessionOut, resumed })
    /* 权威 id 同步进在途表:steer / pause 下发给运行时要按它点名会话(见 inFlightRuns) */
    noteInFlightRun(reqId, { sessionId: sessionOut })
    /* 引擎还在起机时用户就按了 ■：占到位后立刻自毁，不白烧一轮 token */
    if (takeCancelWanted(runTag)) {
      await closeRuntimeByKey(runKey)
      throw new Error('已请求终止')
    }
    const harness = await rt.harness
    if (takeCancelWanted(runTag)) {
      await closeRuntimeByKey(runKey)
      throw new Error('已请求终止')
    }
    /* 新 spawn 的运行时首轮预热:运行时刚起机时插件装载 / 指令基线 / 技能目录加载
       与首条消息之间存在竞态窗口,偶发把用户消息吞掉 → 模型只按系统提示回欢迎语。
       先跑一条极短预热(ok)把运行时拉出竞态窗口,真实消息成为同一进程的第二轮,必定送达;
       已复用的运行时跳过,零开销。
       session 归属:预热轮显式用自己的 warm session(真实轮用 handleRun 顶部铸的
       runSession),两轮因此分属两个独立 session —— 'ok' 不进真实轮的上下文,真实轮的
       宿主提示也不会漏进预热轮;纯净会话(pure)同理只看到自己那条原样用户消息。
       预热轮不接 onNotification:运行时通知(reasoning/text/tool/usage/status…)不进
       mapNotification,不外泄任何事件;它若发起交互(提问/审批/画布/数据库),桥帧 sessionId
       与本轮的归属集合对不上,由 onBridgeFrame 直接 abort —— 预热轮的 ask 没人会答,
       弹出来就是死卡。noteWarmSession 只把它的 session 记进分类账,让日志说清
       「这是预热轮越权」而不是「上一轮遗留」。 */
    if (rt.fresh) {
      const warmSession = 'session-' + crypto.randomUUID().replaceAll('-', '')
      noteWarmSession(runKey, reqId, warmSession)
      try {
        await Promise.race([
          harness.run([{ type: 'text', text: 'ok' }], { sessionId: warmSession }),
          new Promise((resolve) => setTimeout(resolve, WARMUP_TIMEOUT_MS)),
        ])
      } catch {
        /* 预热失败不阻断:最坏情况等同没预热,真实消息照发 */
      }
      /* 用户在预热窗口内按了 ■:占位自毁(与上方取消检查同款写法) */
      if (takeCancelWanted(runTag)) {
        await closeRuntimeByKey(runKey)
        throw new Error('已请求终止')
      }
    }
    /* 跨进程真续跑（session/resume 桥 · 见 plugins/session-resume-server.mjs）：宿主
       点名续跑的会话在这台 runtime 里没有 live 句柄时（失败轮进程已不在 / 复用了他台
       旧 runtime），SDK server 的 create 路径会在 session/created 撞盘上旧日志抛
       id collision（转译 RESUME_UNAVAILABLE → 整轮重发白烧已写上下文）。续跑轮先经
       新 JSON-RPC 方法 session/resume 让运行时用 agents.resume（persistence.prepare
       恢复）把会话拉成 live 并登记进 server 的 sessions 表，随后的 session/prompt
       命中同进程 live 会话 → 真续跑。同进程命中返回 {resumed:false} 零开销；
       恢复失败 → 按 RESUME_UNAVAILABLE 契约收场（宿主退回整轮重发）。
       老运行时没有该方法 / 握手超时 / 进程将死 = 跳过握手走原 create 语义（同进程
       续跑照常、跨进程回落既有 collision 转译），与接入前行为一字不变。 */
    if (canResume && harness && harness.client) {
      try {
        const r = await harness.client.request(
          'session/resume',
          { sessionId: runSession },
          RESUME_HANDSHAKE_TIMEOUT_MS,
        )
        diag(
          `resume-restored reqId=${reqId || '(无)'} sid=${runSession} ` +
          `${r && r.resumed ? 'cross-process' : 'same-process'}`,
        )
      } catch (err) {
        const raw = String((err && err.message) || err)
        /* 不是「恢复失败」的情形：老运行时没有该方法、握手超时、runtime 将死 ——
           跳过握手按原 create 语义跑（与接入前行为一致），绝不误报 RESUME_UNAVAILABLE */
        if (/unknown .*method|timed out|is not running|transport closed|exit code|spawn error|stderr tail/i.test(raw)) {
          diag(`resume-handshake skip reqId=${reqId || '(无)'} sid=${runSession} (${raw.slice(0, 140)})`)
        } else {
          /* 运行时明确拒绝恢复（日志损坏 / 格式版本不符 / 会话属别的 cwd / 已在 live）：
             按 RESUME_UNAVAILABLE 契约收场，宿主据此退回整轮重发 */
          const conv = resumeCollisionMessage(raw, resumeWanted)
          const message = conv ||
            `RESUME_UNAVAILABLE: 会话 ${resumeWanted} 无法在本机恢复（${raw.slice(0, 200)}），请改为整轮重发`
          emit('error', { message: message.slice(0, 500) })
          emit('done', {
            finalResponse: '',
            metrics: buildMetrics ? buildMetrics() : undefined,
            sessionId: sessionOut,
            resumed,
            resumeUnavailable: true,
          })
          return
        }
      }
      /* 握手期间用户按了 ■：与其余取消检查同款占位自毁 */
      if (takeCancelWanted(runTag)) {
        await closeRuntimeByKey(runKey)
        throw new Error('已请求终止')
      }
    }
    emit('status', { state: 'running' })
    /* 运行统计:与 dsh 客户端一致的信息表达(轮/步/时间/token/子代理/后台任务) */
    /* 逐模型台账:一次运行内 request/context 可能改写路由(子代理 / 模型切换),
       所以按 provider|model 分别累计输入/输出/缓存与时间 —— 客户端的 Token 报告要用 */
    const stats = {
      turns: 0, steps: 0, llmMs: 0, toolMs: 0, firstTokenMs: [],
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      subagents: 0, jobs: 0, tools: [], contextWindow: 0,
      startedAt: Date.now(), endedAt: 0, wallMs: 0,
    }
    const byModel = new Map()
    let curProvider = String(route || '')
    let curModel = String(model || '')
    const modelBucket = () => {
      const key = curProvider + '|' + curModel
      let b = byModel.get(key)
      if (!b) {
        b = {
          provider: curProvider, model: curModel,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 0, calls: 0, steps: 0, llmMs: 0, toolMs: 0,
          /* 逐模型性能样本(additive:老消费方忽略即可)—— TTFT 累计与样本数、
             本次调用的计费输入(算预处理吞吐)、扣除 TTFT 后的纯生成时间 */
          ttftMs: 0, ttftSamples: 0, prefillTokens: 0, genMs: 0,
        }
        byModel.set(key, b)
      }
      return b
    }
    let stepStart = 0
    /* 本步首 Token 延迟:在首个增量处采样,等到该次调用的 usage 到达时
       一并记进「同一次调用所属」的模型桶(与 llmMs 同桶,数额不会错配) */
    let stepTtft = 0
    let firstSeen = false
    let toolStart = 0
    let toolBucket = null
    /* 一次运行的完整度量(含逐模型台账与墙钟);异常/终止也照记,累计报告不能漏账 */
    buildMetrics = () => {
      const ft2 = stats.firstTokenMs
      stats.endedAt = Date.now()
      stats.wallMs = stats.endedAt - stats.startedAt
      const cacheTotal = stats.cacheReadTokens + stats.cacheWriteTokens
      const billed = stats.inputTokens + cacheTotal
      return {
        turns: stats.turns,
        steps: stats.steps,
        llmMs: stats.llmMs,
        toolMs: stats.toolMs,
        firstTokenAvgMs: ft2.length ? ft2.reduce((a, b) => a + b, 0) / ft2.length : 0,
        tokPerSec: stats.llmMs > 0 ? stats.outputTokens / (stats.llmMs / 1000) : 0,
        cacheHitPct: billed > 0 ? (stats.cacheReadTokens / billed) * 100 : 0,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        reasoningTokens: stats.reasoningTokens,
        subagents: stats.subagents,
        jobs: stats.jobs,
        tools: stats.tools,
        contextWindow: stats.contextWindow,
        wallMs: stats.wallMs,
        startedAt: stats.startedAt,
        endedAt: stats.endedAt,
        /* 逐模型:每个 provider|model 各自的 token 与时间,报告 Badge 展开按行显示。
           性能字段为 additive:ttftAvgMs 由 ttftMs/ttftSamples 得出;端到端与吞吐
           由既有 llmMs / calls / outputTokens / genMs 推出(不新增冗余口径) */
        models: [...byModel.values()].map((b) => {
          const bIn = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens
          return Object.assign({}, b, {
            cacheHitPct: bIn > 0 ? (b.cacheReadTokens / bIn) * 100 : 0,
            ttftAvgMs: b.ttftSamples > 0 ? b.ttftMs / b.ttftSamples : 0,
          })
        }),
      }
    }
    /* 本轮首条 session.event 之前 session 归属只靠网关铸的 runSession;
       首条到达后以运行时给的为权威(见 rebindRunSession) */
    let sessionBound = false
    const result = await harness.run(blocks, {
      /* 显式绑定本轮 session:交互桥帧(question / approval)按它判归属,
         预热轮与上一轮遗留轮次的提问因此可被识别并 abort(见 onBridgeFrame) */
      sessionId: runSession,
      onNotification: (n) => {
        /* 登记本轮会话树里出现过的 session id(真实轮 + 它派生的子代理 / 后台 job)。
           SDK 只把本轮那棵树的通知送进这个回调,且首条必是真实轮的收件回执,
           所以首条的 sessionId 就是运行时真正在跑的根 session —— 若与网关铸的不一致
           (运行时自己另铸 / 版本漂移),以事件里的为准。 */
        const sid = n && n.params ? n.params.sessionId : ''
        if (typeof sid === 'string' && sid) {
          noteRunSession(runKey, reqId, sid)
          if (!sessionBound && n.method === 'session.event') {
            sessionBound = true
            /* 权威 id 变了(运行时自行另铸 / 版本漂移)就把新 id 再报一次给宿主:
               宿主存的就是续跑用的 id,口径不能停留在已被证伪的旧值上 */
            const rebound = rebindRunSession(runKey, reqId, sid)
            if (rebound && rebound !== sessionOut) {
              sessionOut = rebound
              emit('session', { sessionId: rebound, resumed })
              /* 改判后的权威 id 同样回填在途表,steer / pause 才不会点到没人用的旧 id */
              noteInFlightRun(reqId, { sessionId: rebound })
            }
          }
        }
        mapNotification(n, emit, { resumed, sid: resumeWanted, host: hostSessionId })
        if (n.method !== 'session.event' || !n.params || !n.params.event) return
        const ev = n.params.event
        const t = ev.time || Date.now()
        const d = ev.data
        switch (ev.type) {
          case 'turn/start':
            stats.turns++
            break
          case 'step/start':
            stats.steps++
            stepStart = t
            stepTtft = 0
            firstSeen = false
            modelBucket().steps++
            break
          case 'assistant/chunk': {
            const c = d && d.chunk
            if (!c) break
            if (!firstSeen && (c.type === 'reasoning-delta' || c.type === 'text-delta') && stepStart) {
              stats.firstTokenMs.push(t - stepStart)
              stepTtft = t - stepStart
              firstSeen = true
            }
            if (c.type === 'usage' && c.usage) {
              const u = {
                inputTokens: Number(c.usage.inputTokens) || 0,
                outputTokens: Number(c.usage.outputTokens) || 0,
                cacheReadTokens: Number(c.usage.cacheReadTokens) || 0,
                cacheWriteTokens: Number(c.usage.cacheWriteTokens) || 0,
                reasoningTokens: Number(c.usage.reasoningTokens) || 0,
              }
              accountUsage({ stats, modelBucket, emit, stepStart, stepTtft }, u, t)
              stepStart = 0
              stepTtft = 0
            }
            break
          }
          /* dsh 0.2 的用量真源：完整 assistant/message 上的 data.usage（0.2 不再发
             assistant/chunk 增量帧，见文件头 synthesizeChunksFromStream 的说明）。
             没有这一支 = 一个 token 都统计不到（会话 Token 报告全 0 的根因）。 */
          case 'assistant/message': {
            const ru = d && d.usage
            if (!ru) break
            const u = {
              inputTokens: Number(ru.inputTokens) || 0,
              outputTokens: Number(ru.outputTokens) || 0,
              cacheReadTokens: Number(ru.cacheReadTokens) || 0,
              cacheWriteTokens: Number(ru.cacheWriteTokens) || 0,
              reasoningTokens: Number(ru.reasoningTokens) || 0,
            }
            /* 五个口径全 0 = 这次调用没有用量权威值（老适配器 / 非计费路径），不记账，
               免得凭空多一「次」调用把均值与轮次统计拉歪 */
            if (
              !u.inputTokens && !u.outputTokens && !u.cacheReadTokens &&
              !u.cacheWriteTokens && !u.reasoningTokens
            ) break
            accountUsage({ stats, modelBucket, emit, stepStart, stepTtft }, u, t)
            stepStart = 0
            stepTtft = 0
            break
          }
          case 'tool/call': {
            const name = (d && (d.name || d.tool)) || ''
            stats.tools.push({ name, at: t })
            toolStart = t
            toolBucket = modelBucket()
            break
          }
          case 'tool/result': {
            if (toolStart) {
              const ms = t - toolStart
              stats.toolMs += ms
              if (toolBucket) toolBucket.toolMs += ms
            }
            toolStart = 0
            toolBucket = null
            break
          }
          case 'subagent.started':
            stats.subagents++
            break
          case 'request/context':
            if (d && d.contextWindow) stats.contextWindow = Number(d.contextWindow) || 0
            /* 路由被改写(换服务商 / 换模型):之后的 usage 记到新模型名下 */
            if (d && d.provider) curProvider = String(d.provider)
            if (d && d.model) curModel = String(d.model)
            break
          default:
            /* 其余事件(含 steer 的插话回流:agent/inbox/spliced / steering 相关、
               pause 的 turn/end reason aborted)一律不记账:token 只在上面的 usage 增量块
               累计、jobs 只数 job/*started —— 插话只是往同一棵树里多塞一条用户消息,
               它自己的用量会在所属那次调用的 usage 里正常出现,不会双计也不会漏账。 */
            if (ev.type.startsWith('job/') && ev.type.endsWith('started')) stats.jobs++
        }
      },
    })
    /* 暂停收尾:pause 之后运行时让本轮以 aborted 收流,harness.run 照常 resolve
       (只是再等不到新的 assistant 增量)。宿主据此把界面从「跑着」切回「已暂停」,
       并且因为**没有 error 事件**,重发闸不会触发。 */
    const pausedFinish = runPaused()
    emit('done', {
      finalResponse: result.finalResponse,
      metrics: buildMetrics(),
      /* done 也带上本轮权威 session id:宿主据此存档,崩溃/断线后才能点名续跑 */
      sessionId: sessionOut,
      resumed,
      ...(pausedFinish ? { paused: true } : {}),
    })
    /* harness.run 正常收流但通知里报过错(如 turn/end reason error 的 429/5xx):
       宿主同样判本轮失败,并会在重发窗口点名续跑 —— 留同样的保活标记。
       (暂停之后报的错已在 emit 里吞掉,runErrorMsg 只剩暂停前就报过的,照旧保活) */
    if (runErrorMsg) failForResume = runErrorMsg
  } catch (err) {
    const rawMessage = String((err && err.message) || err)
    const message = rawMessage.slice(0, 800)
    /* 运行时进程已死:清掉池里的僵尸 harness,下次 run 重新 spawn。
       这段排在最前:它与「本轮结局是什么」无关(进程真死了就得清),暂停轮也不例外。 */
    if (
      runKey &&
      /runtime is not running|TransportClosed|Harness runtime closed|EPIPE|EOF/i.test(
        message,
      )
    ) {
      const dead = runtimes.get(runKey)
      if (dead) {
        runtimes.delete(runKey)
        resumeCandidates.delete(runKey)
        closeBridge(runKey)
        forgetKey(runKey)
        try {
          void dead.harness.then((h) => h.close()).catch(() => {})
        } catch {}
      }
    }
    /* 本轮被宿主暂停:pause 之后 harness.run 的收尾方式不唯一(多数是正常 resolve,
       运行时可能同时把会话关掉 → 这里抛 TransportClosed / '已请求终止' 一类)。抛到这里
       的一律**不 emit('error')**,按「暂停完成」收场:宿主的重发闸只看 error 事件,
       把 aborted 当失败会让一次暂停连烧 5 轮(见 pausedRuns / emit 里的吞错)。
       放在 collision 转译之前:暂停优先于一切失败语义。 */
    if (runPaused()) {
      diag(`pause-finish reqId=${runIdKey || '(无)'} via=catch msg=${message.slice(0, 120)}`)
      emit('done', {
        finalResponse: '',
        metrics: buildMetrics ? buildMetrics() : undefined,
        sessionId: sessionOut,
        resumed,
        paused: true,
      })
      return
    }
    /* 续跑轮在 harness.run 期间撞运行时侧 id collision —— 走到这里说明会话/resume 握手
       未拦截住:老运行时没有该方法而回落原 create 语义,新 runtime 以空 seed create 撞盘上
       旧日志(真正不可恢复的兜底路径,状态 C 第 3 条;握手阶段的恢复失败已在 run 前收场)。
       按 RESUME_UNAVAILABLE 契约收场(转译文案 + resumeUnavailable:true),宿主据此
       退回整轮重发;绝不能原样透传 —— 宿主会把同一个 dead id 连撞 5 次重发预算。 */
    if (resumed) {
      const conv = resumeCollisionMessage(rawMessage, resumeWanted)
      if (conv) {
        emit('error', { message: conv.slice(0, 500) })
        emit('done', {
          finalResponse: '',
          metrics: buildMetrics ? buildMetrics() : undefined,
          sessionId: sessionOut,
          resumed,
          resumeUnavailable: true,
        })
        return
      }
    }
    /* 失败轮以可重发错误收尾 → finally 给 runtime 打「续跑候选」保活标记
       (等待宿主 ~5s 后的续跑轮点名复用同进程;取消 / 配置 / 会话不可续跑等
       宿主不会重发的报文在 markResumeCandidate 里被滤掉) */
    failForResume = rawMessage
    emit('error', { message })
    /* 出错收场也要把本轮权威 session id 交出去:宿主正是靠这一轮失败后的 id 决定
       下轮能否点名续跑(拿不到就退化成整轮重发)。若这一轮在起 runtime 前就炸了,
       该 id 在磁盘上根本没有会话文件,下一次续跑会被判 RESUME_UNAVAILABLE 自动退回重发 */
    emit('done', {
      finalResponse: '',
      metrics: buildMetrics ? buildMetrics() : undefined,
      sessionId: sessionOut,
      resumed,
    })
  } finally {
    if (runKey) {
      /* 只有自己仍占着这台时才清桥:已被下一轮接手的，不能拆它的交互桥 */
      const owns = releaseClaim(runKey, reqId, runTag)
      /* reqId 显式传进去:占用登记刚被清掉,不传就没人知道这些卡属于哪一轮了 */
      if (owns) abortBridgePending(runKey, null, reqId)
      /* 失败轮收尾:解除占用后打「续跑候选」保活标记(空闲 runtime 才需要保活;
         有在途 claim 的本就被 keyToReqId 护着,LRU 从不碰)。下一轮正常占用这台时
         claimRuntime 会摘掉标记,时限到也会自动清,不会永久占着豁免名额 */
      if (failForResume) markResumeCandidate(runKey, reqId, failForResume)
    }
    if (runTag) {
      activeRunTags.delete(runTag)
      /* 本轮已结束：残留的待取消标记属于下一轮之前的心智垃圾，清掉避免误杀 */
      cancelWanted.delete(runTag)
    }
    /* 本轮到此真的收尾:摘掉在途登记与暂停标记。之后 steer / pause 找不到这一轮,
       宿主拿到 unsupported 自行回落成普通排队消息(与 cancel 后 tagToKey 清空同理)。 */
    clearInFlightRun(reqId)
  }
}

async function closeRuntimeByKey(k) {
  /* 续跑候选豁免:保活窗口内不随普通关闭流程回收 —— 失败轮进程要留给宿主
     重发窗口的续跑轮点名复用(同进程才能 SDK server 进程内命中;换进程 = 续不上
     → 整轮重发白烧)。时限到 / 被新一轮正常占用后标记清除,豁免自然解除。
     用户取消路径不受影响:cancelRuntime 关进程前先 clearResumeCandidate 再进来,
     显式的「终止」永远压过保活窗口。 */
  if (resumeCandidateOf(k)) return false
  const v = runtimes.get(k)
  if (!v) return false
  runtimes.delete(k)
  resumeCandidates.delete(k)
  closeBridge(k)
  forgetKey(k)
  try {
    await v.harness.then((h) => h.close())
  } catch {}
  return true
}

async function closeAllRuntimes() {
  const jobs = []
  for (const [k, v] of runtimes) {
    runtimes.delete(k)
    closeBridge(k)
    jobs.push(v.harness.then((h) => h.close()).catch(() => {}))
  }
  forgetKey(null)
  /* 全关 = 显式重启/退出:续跑候选保活窗口一并作废(进程都没了,无从保活) */
  resumeCandidates.clear()
  await Promise.all(jobs)
}

/* 思考强度:档位与归一化的唯一真源在 ./reasoning-effort.mjs(纯函数,codex
   reasoning_effort_for_request 式),gateway 与运行时 mtnode-effort 插件共用。
   要点回顾:
   - 可选用档 = off/low/medium/high/xhigh/max(对齐 pi-ai 能力集;off = 会话 / 助手
     「思考强度 · 无」= 关闭思考,只在明确选了 off 时才下发、不参与同侧回退;minimal 无消费方)。
   - 空串与非法值 → high(兜底默认,与历史 normalizeEffort 一致)。
   - DeepSeek 官方路由(llm-deepseek 适配器)能力 off/low/high/max → 可选用交集
     off/low/high/max:off 原样(关思考),medium/xhigh 按「同侧最近低档」回退
     (medium→low, xhigh→high);目录/pi-ai 等其余路由按全档,模型级精确能力由运行时插件
     经 ctx.llm 解析后再夹。
   - 归一化永不硬失败;档位只在 runtime key 与 env MTNODE_EFFORT 里随 run 走,
     settings.yaml 的 llm-deepseek.reasoningEffort 只保留兜底默认(见 applySettings)。 */

/* ── 用户工具描述子（工具节点 func call）归一 ───────────────────────────
 * 宿主每次 run 随参数下发工具清单（画布工具节点 + 库中「随时可调用」），
 * 网关只做收口：字段白名单 + 上限裁剪（env 块有 ~32KB 总量约束），产出
 * 稳定的 JSON 供运行时 tools-plugin.mjs 在 spawn 时注册同名函数调用工具。
 * key = "cn:<nodeId>"（画布）/ "lib:<id>"（工具库）；toolName 由宿主预生成
 * ASCII 注册名（模型按它调用）；name 是给模型看的人类工具名。 */
const MAX_RUN_TOOLS = 24
const MAX_TOOL_DESC = 300
function normRunTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return []
  const out = []
  const seenName = new Set()
  const seenKey = new Set()
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    if (out.length >= MAX_RUN_TOOLS) break
    const key = String(t.key || '').trim()
    const toolName = String(t.toolName || '').trim()
    if (!key || seenKey.has(key)) continue
    if (!toolName || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(toolName)) continue
    if (seenName.has(toolName)) continue
    const norm = (list) =>
      Array.isArray(list)
        ? list
            .map((p) =>
              p && typeof p === 'object' && p.name != null
                ? { name: String(p.name).slice(0, 60), kind: p.kind === 'image' ? 'image' : 'text' }
                : null,
            )
            .filter(Boolean)
            .slice(0, 16)
        : []
    seenKey.add(key)
    seenName.add(toolName)
    out.push({
      key,
      toolName,
      name: String(t.name || '').slice(0, 60) || toolName,
      description: String(t.description || '').slice(0, MAX_TOOL_DESC),
      inputs: norm(t.inputs),
      outputs: norm(t.outputs),
    })
  }
  return out
}

/* 删除 settings.yaml 中的整段顶层键(含其全部缩进子行),保留其余内容 */
function stripYamlSection(text, key) {
  const out = []
  let skipping = false
  for (const line of text.split('\n')) {
    const head = /^(\s*)\S/.exec(line)
    if (!head) {
      out.push(line)
      continue
    }
    if (!head[1]) {
      skipping = line.split(':')[0].trim() === key
      if (!skipping) out.push(line)
      continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/* 统一写入宿主管理的 settings 段(llm-deepseek / llm-pi-ai.providers /
   permission.defaultPreset / 可选 system-prompt 宿主人设),其余用户内容原样保留;envPatch 始终构建,
   保证同一配置复用同一运行时。 */
/* 权限档表:键序即「档位清单」,值即 cordis.yml `- id: permission` 的同一张表(唯一真源;
   实测按 id 打补丁是**整份替换 config**而不是深合并,所以托管叠加层每次都必须带上全表,
   少一个键 = 那个档在运行时不存在,插件构造时 resolve() 直接抛错、整行不激活)。
   sandbox/approval 语义:
     · read-only            只读沙箱 + 逐项审批
     · workspace-write      工作区读写 + 逐项审批
     · danger-full-access   不限目录 + 不询问
     · mtnode-super-ask     沙箱全开 + 越权时询问(智能节点「超级权限 · 询问外部」)
     · bongochat            只读沙箱 + 逐项审批(桌宠对话,宿主侧再逐项放行/拒绝)
     · mtnode-unattended    工作区读写 + 沙箱拒绝时询问(默认档:限制不放松,只把拒绝改成询问) */
const PERMISSION_PRESETS = [
  'mtnode-unattended',
  'read-only',
  'workspace-write',
  'danger-full-access',
  'mtnode-super-ask',
  'bongochat',
]
/* 档位 → 沙箱 / 审批。与 cordis.yml 那张表逐字一致(改一处必须改另一处,冒烟会核对)。 */
const PERMISSION_PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  'mtnode-super-ask': { sandbox: 'danger-full-access', approval: 'ask' },
  bongochat: { sandbox: 'read-only', approval: 'ask' },
  'mtnode-unattended': { sandbox: 'workspace-write', approval: 'ask' },
}
/* 托管 permission 行的完整 config:全表 + 当前选定档。**必须带全表** ——
   补丁按 id 整份替换 config(applyEntryPatches: target[key] = value,不是深合并),
   只写 defaultPreset 会把 cordis.yml 的 presets 表连带抹掉,插件回落自带的
   workspace-write/danger-full-access 两个默认档,构造期 resolve('mtnode-unattended')
   抛错 → 整行不激活(实测 stderr: permission: unknown preset "mtnode-unattended")。 */
function permissionPresetsConfig(defaultPreset) {
  const presets = {}
  for (const id of PERMISSION_PRESETS) {
    const spec = PERMISSION_PRESET_SPECS[id]
    presets[id] = { sandbox: spec.sandbox, approval: spec.approval }
  }
  return { presets, defaultPreset }
}
let lastSettingsHome = ''
let lastSettingsHash = ''

/* 目录同源判定:沿用 dsh 的目录注册方案 —— 服务商的 baseURL 与全部模型
   都落在同一 pi-ai 内置目录服务商内时,返回该目录 id(引擎按目录路由名注册,
   llm-pi-ai 自动合并目录里的模型元数据:reasoning / compat(thinkingFormat、
   requiresReasoningContentOnAssistantMessages、thinkingLevelMap)/ 上下文 /
   输出上限 / 成本)。否则返回空串,走通用 mtnode 路由(保持原行为)。 */
function catalogIdOf(p) {
  const base = String(p.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '')
  const ids = new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m)))
  if (!base || !ids.size) return ''
  let best = ''
  let bestCount = 0
  try {
    for (const prov of getBuiltinProviders()) {
      /* mtnode 的 DeepSeek 走 llm-deepseek 官方路由,目录里的 deepseek 不参与 */
      if (prov === 'deepseek') continue
      let hit = false
      let count = 0
      for (const m of getBuiltinModels(prov)) {
        if (m.api !== 'openai-completions') continue
        const mb = String(m.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '')
        if (mb && mb === base) hit = true
        if (ids.has(m.id)) count++
      }
      /* 命中同一端点,且服务商模型全部是目录模型(模型集为目录子集) */
      if (!hit || count === 0 || count !== ids.size) continue
      if (count > bestCount) {
        best = prov
        bestCount = count
      }
    }
  } catch {
    /* 目录不可用时退回通用路由 */
  }
  return best
}

/* 渲染层下发的 provider 串 → 引擎路由:目录同源服务商映射回目录路由名
   (settings 与握手都按该名注册),其余保持 mtnode_<route> / deepseek-official。 */
function routeOfProvider(provider, list) {
  const raw = typeof provider === 'string' && provider ? provider : 'deepseek-official'
  if (raw === 'deepseek-official') return raw
  for (const p of list || []) {
    if ('mtnode_' + (p.route || 'p') !== raw) continue
    return catalogIdOf(p) || raw
  }
  return raw
}

function yamlHostPersonaSection(text) {
  const safe = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/\{\{/g, '{ {')
  const body = safe.split('\n').map((line) => '    ' + line).join('\n')
  return (
    'system-prompt:\n' +
    '  includeHarnessIdentity: false\n' +
    '  includeRuntimeContext: false\n' +
    '  persona: |-\n' +
    body
  )
}

/* ── DeepSeek 官方模型清单(宿主 run 参数 → settings.yaml 的 llm-deepseek.models)──
   宿主按「官方模型」勾选把清单随 run 参数下发(params.officialModels);这里只做归一
   (白名单 id 字符 / 去重保序 / 条数上限 / 补已知别名),落盘交给 applySettings。
   清单为空 = 不写 models 键,适配器用自己的 DEFAULT_MODELS —— 行为与接入前一字不差。
   写在 llm-deepseek 段是契约内行为:该段本来就由宿主托管(与 reasoningEffort 同段),
   适配器每次操作重读 settings(catalog 在首次使用时的快照上校验),故不进 runtime key。 */
const OFFICIAL_MODELS_MAX = 24
/* id 直接进 YAML 标量:只放行字母数字开头的安全字符(冒号 / 引号 / 空白一律拒),
   既挡 YAML 注入,也挡适配器 catalog 校验会拒的空 id / 重名。 */
const OFFICIAL_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,63}$/
const OFFICIAL_MODEL_MODALITIES = ['text', 'image']
/* 已知官方模型的元数据兜底(真源:dsh-llm-deepseek 的 DEFAULT_MODELS 与 gateway 的
   providerCatalog):宿主只给 id 字符串时用来补 name / 上下文窗口 / 输入模态。 */
const OFFICIAL_MODEL_KNOWN = {
  'deepseek-v4-flash': { name: 'DeepSeek-V4-Flash', contextWindow: 1000000, inputModalities: ['text'] },
  'deepseek-v4-pro': { name: 'DeepSeek-V4-Pro', contextWindow: 1000000, inputModalities: ['text'] },
  'deepseek-v4-flash-vision-exp': { name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1000000, inputModalities: ['text', 'image'] },
  'deepseek-flash': { name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, inputModalities: ['text', 'image'] },
}
/* 别名组:组内任一 id 在清单里 → 同组其它名字一并写入(元数据同源、模态取并集)。
   MTNode 下发的名字与适配器目录名(deepseek-flash ⇄ deepseek-v4-flash /
   -vision-exp)不一致时 catalog 会落空 —— 而 catalog 落空 = 图片输入在凭据与网络
   之前就被拒,所以别名必须能互相命中。 */
const OFFICIAL_MODEL_ALIAS_GROUPS = [
  ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-flash-vision-exp'],
]

function officialModelAliasesOf(id) {
  return OFFICIAL_MODEL_ALIAS_GROUPS.find((g) => g.includes(id)) || []
}

/* 输入模态归一:只留 text / image,去重保序;非法值丢弃(空则由调用方兜底 ["text"]) */
function officialModelModalities(v) {
  const raw = Array.isArray(v) ? v : v == null ? [] : [v]
  const out = []
  for (const m of raw) {
    const s = String(m || '').trim().toLowerCase()
    if (!OFFICIAL_MODEL_MODALITIES.includes(s) || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/* 宿主清单 → 规范条目(去重保序、上限 OFFICIAL_MODELS_MAX);接受对象或纯 id 字符串 */
function normalizeOfficialModels(raw) {
  const out = []
  const seen = new Set()
  const push = (e) => {
    if (out.length >= OFFICIAL_MODELS_MAX || seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }
  for (const item of Array.isArray(raw) ? raw : []) {
    const src = typeof item === 'string' ? { id: item } : item && typeof item === 'object' ? item : null
    if (!src) continue
    const id = String(src.id ?? '').trim()
    if (!OFFICIAL_MODEL_ID_RE.test(id)) continue
    const known = OFFICIAL_MODEL_KNOWN[id] || {}
    const name = String(src.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || known.name || id
    const ctx = Number(src.contextWindow)
    const max = Number(src.maxTokens)
    const given = officialModelModalities(src.inputModalities ?? src.input ?? src.modalities)
    push({
      id,
      name,
      contextWindow: Number.isInteger(ctx) && ctx > 0 ? ctx : known.contextWindow || 0,
      maxTokens: Number.isInteger(max) && max > 0 ? max : known.maxTokens || 0,
      inputModalities: given.length ? given : [...(known.inputModalities || ['text'])],
    })
  }
  /* 别名映射:在原始条目(保序)之后补同组别名,元数据同源、模态与别名已知能力取并集 */
  for (const e of [...out]) {
    for (const alias of officialModelAliasesOf(e.id)) {
      const known = OFFICIAL_MODEL_KNOWN[alias] || {}
      const mods = [...e.inputModalities]
      for (const m of known.inputModalities || []) if (!mods.includes(m)) mods.push(m)
      push({
        id: alias,
        /* 别名优先用已知名字(宿主给的是它自己那条的显示名),未知别名沿用同源名字 */
        name: known.name || e.name,
        contextWindow: e.contextWindow || known.contextWindow || 0,
        maxTokens: e.maxTokens || known.maxTokens || 0,
        inputModalities: OFFICIAL_MODEL_MODALITIES.filter((m) => mods.includes(m)),
      })
    }
  }
  return out
}

/* 规范条目 → 0.2 profile patch 行 llm-deepseek.config.models 的 YAML 片段 */
function officialModelsYaml(models) {  const lines = ['  models:']
  for (const m of models) {
    lines.push('    - id: ' + m.id)
    lines.push('      name: ' + yamlStr(m.name))
    if (m.contextWindow > 0) lines.push('      contextWindow: ' + m.contextWindow)
    if (m.maxTokens > 0) lines.push('      maxTokens: ' + m.maxTokens)
    lines.push('      inputModalities: [' + m.inputModalities.join(', ') + ']')
  }
  return lines.join('\n')
}

/* ── 宿主托管的设置行 → 0.2 运行时叠加层（--patch）──────────────────────────────
   0.2 运行时删掉了 settings-file 行：dsh-settings 在 Loader 结算后把
   <DSH_HOME>/settings.yaml 改名 .imported 并导入 active profile，此后**不再读该文件** ——
   继续写它等于写进死信（实测目录里只剩 .imported）。
   0.2 的真源是**补丁层**，但两处都打不到宿主托管的那几行：
     · <DSH_HOME>/profiles/sdk/cordis.patch.yml（用户补丁层）：打得到顶层行
       （permission 实测生效），打不到基座 `insert:` 里插进来的行
       （llm-deepseek / system-prompt / llm-pi-ai —— 实测补丁被忽略）；
     · 运行时自己的 ctx.settings.update：直接拒绝 —— 实测回
       「Configuration for "llm-deepseek" is overridden by a home patch or command-line overlay」。
   能同时打到全部四行的只有**命令行叠加层**（`--patch <file>`，层序在用户补丁层之后）：
   把托管段写成 <DSH_HOME>/mtnode-settings.patch.yml，随 cordis.yml 之后一起下发
   （见 DeepSeekHarness 的 patches）。实测四段全部抵达运行时（config/probe 可复核）。 */
const MANAGED_PATCH_IDS = ['llm-deepseek', 'llm-pi-ai', 'permission', 'system-prompt']
/* 标量 → YAML：一律单引号（内部单引号翻倍），数字 / 布尔原样，免掉转义坑。 */
function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return yamlStr(v)
}
function managedSettingsPatchPath(home) {
  return path.join(home, 'mtnode-settings.patch.yml')
}

function writeManagedSettingsPatch(home, rows) {
  const file = managedSettingsPatchPath(home)
  /* 整文件重写：本文件**只**装 MTNode 托管段（由 applySettings 每次运行前重写），
     用户自己的补丁请放 profiles/sdk/cordis.patch.yml —— 两处职责不重叠。 */
  const header = [
    '# MTNode 托管设置（服务商目录 / 权限预设 / 官方模型清单 / 宿主人设）',
    '# 由 dsh/gateway/gateway.mjs 的 applySettings 每次运行前整份重写，作为 --patch 叠加层',
    '# 下发（层序在 cordis.yml 与 profile 用户层之后 = 最后写入者胜）。请勿手改：',
    '# 手艺改请写 <DSH_HOME>/profiles/sdk/cordis.patch.yml。',
  ].join('\n')
  const body = rows
    .map((row) => {
      const lines = ['- id: ' + row.id, '  config:']
      const walk = (value, indent) => {
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined || v === null) continue
          if (Array.isArray(v)) {
            lines.push(indent + k + ':')
            for (const item of v) {
              if (item && typeof item === 'object') {
                const entries = Object.entries(item)
                lines.push(indent + '  - ' + entries[0][0] + ': ' + yamlScalar(entries[0][1]))
                for (const [ik, iv] of entries.slice(1)) {
                  if (iv === undefined || iv === null) continue
                  if (Array.isArray(iv)) {
                    lines.push(indent + '    ' + ik + ': [' + iv.map(yamlScalar).join(', ') + ']')
                  } else {
                    lines.push(indent + '    ' + ik + ': ' + yamlScalar(iv))
                  }
                }
              } else {
                lines.push(indent + '  - ' + yamlScalar(item))
              }
            }
          } else if (typeof v === 'object') {
            lines.push(indent + k + ':')
            walk(v, indent + '  ')
          } else {
            lines.push(indent + k + ': ' + yamlScalar(v))
          }
        }
      }
      walk(row.config, '    ')
      return lines.join('\n')
    })
    .join('\n')
  mkdirSync(home, { recursive: true })
  writeFileSync(file, header + '\n' + body + '\n', 'utf8')
  return file
}

function applySettings(dshHome, effort, mtnodeProviders, permissionPreset, hostPersona, officialModels) {
  const home = dshHome || process.env.DSH_HOME || ''
  const list = Array.isArray(mtnodeProviders) ? mtnodeProviders : []
  const envPatch = {}
  list.forEach((p, i) => {
    if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
    envPatch['MTNODE_KEY_' + (i + 1)] = String(p.apiKey || '')
  })
  if (!home) return { envPatch, changed: false }
  /* llm-deepseek.reasoningEffort 只保留兜底默认(DEFAULT_EFFORT = high):
     思考档已改经 env MTNODE_EFFORT + 运行时 mtnode-effort 插件逐步下发(见上方
     EFFORTS 注释段)——档位切换不再写设置、不再触发热重载与多余 450ms 等待,
     runtime 隔离由 runtime key(含档位)承担。llm-deepseek 适配器省略 reasoningEffort
     时本身也回退 high,与本默认一致,插件缺席时行为与接入前一字不变。 */
  const eff = DEFAULT_EFFORT
  /* 权限预设:dsh permission-presets 的 defaultPreset,热重载后对新会话生效 */
  const perm = PERMISSION_PRESETS.includes(permissionPreset) ? permissionPreset : 'mtnode-unattended'
  const persona = String(hostPersona || '').trim()
  /* 官方模型清单:归一后按序进指纹 —— 清单变了要重写(热重载),清单没变则一次都不重写。 */
  const om = (Array.isArray(officialModels) ? officialModels : []).filter((m) => m && OFFICIAL_MODEL_ID_RE.test(String(m.id || '')))
  const hash = eff + '|' + perm + '|' + JSON.stringify(list) + '|hp:' + persona + '|om:' + JSON.stringify(om)
  if (hash === lastSettingsHash && home === lastSettingsHome) return { envPatch, changed: false }
  try {
    const providers = {}
    list.forEach((p, i) => {
      if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
      const cat = catalogIdOf(p)
      const route = cat || 'mtnode_' + (p.route || 'p' + (i + 1))
      const entry = {
        apiKeyEnv: 'MTNODE_KEY_' + (i + 1),
        /* baseURL 无凭据间接层:直接写 URL(非机密),密钥仅经 env 引用 */
        baseURL: String(p.baseUrl).trim(),
      }
      /* 目录同源路由不写 api:模型级 api 以目录元数据为准(多协议目录如
         opencode-go 同时含 openai-completions 与 anthropic-messages);
         通用路由保留 api 声明(默认 openai-completions) */
      if (!cat) entry.api = String(p.api || 'openai-completions')
      entry.models = (p.models || []).map((m) => ({ id: String(m) }))
      providers[route] = entry
    })
    const deepseek = { reasoningEffort: eff }
    /* 官方模型清单只在非空时写 models 键(空 = 不写,适配器用自身 DEFAULT_MODELS) */
    if (om.length) {
      deepseek.models = om.map((m) => {
        const row = { id: m.id }
        if (m.name) row.name = m.name
        if (m.contextWindow > 0) row.contextWindow = m.contextWindow
        if (m.maxTokens > 0) row.maxTokens = m.maxTokens
        if (Array.isArray(m.inputModalities) && m.inputModalities.length) row.inputModalities = m.inputModalities
        return row
      })
    }
    const rows = [
      { id: 'llm-deepseek', config: deepseek },
      /* permission 行带全表(见 permissionPresetsConfig):整份替换语义下少写一个键
         就等于那个档在运行时不存在,插件构造期直接抛错。 */
      { id: 'permission', config: permissionPresetsConfig(perm) },
    ]
    if (Object.keys(providers).length) rows.push({ id: 'llm-pi-ai', config: { providers } })
    if (persona) {
      rows.push({
        id: 'system-prompt',
        config: {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: persona,
        },
      })
    }
    const overlayFile = writeManagedSettingsPatch(home, rows)
    lastSettingsHome = home
    lastSettingsHash = hash
    return { envPatch, changed: true, overlayFile }
  } catch (err) {
    /* 尽力而为:写入失败不阻断任务,保留运行时默认档。留一行诊断:这条路径静默吞错,
       「设置没写出来」类问题只能靠这行定位。 */
    try { process.stderr.write('applySettings: ' + String((err && err.stack) || err) + '\n') } catch { /* ignore */ }
    return { envPatch, changed: false }
  }
}

/* pi-ai 目录(dsh 同源):走 pi-ai 自带的注册表 API(providers/all),
   而非裸读 data/*.json(那是以 api 种类为顶层键的模型表,不是服务商表)。 */
function piAiCatalog() {
  const out = []
  try {
    for (const id of getBuiltinProviders()) {
      /* mtnode 的 DeepSeek 走 llm-deepseek 官方路由,目录里的 deepseek 不重复列出 */
      if (id === 'deepseek') continue
      try {
        const models = getBuiltinModels(id).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: Number(m.contextWindow) || 0,
          maxTokens: Number(m.maxTokens) || 0,
          api: m.api || '',
          baseUrl: m.baseUrl || '',
          input: Array.isArray(m.input) ? m.input : [],
        }))
        if (models.length) out.push({ id, models })
      } catch { /* 动态/未知服务商跳过 */ }
    }
  } catch {
    return out
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/* 权限预设的 cordis 基础层:rc.6 运行时的 settings 注入回调晚于首个会话创建,
   首个会话固定钉住 cordis 配置里的 defaultPreset;每次运行前把用户选择写进
   cordis.yml,新运行时首个会话即用所选预设(热切换由 settings 段覆盖)。 */
let lastCordisPreset = ''
function applyCordisPreset(preset) {
  const perm = PERMISSION_PRESETS.includes(preset) ? preset : 'mtnode-unattended'
  if (perm === lastCordisPreset) return false
  try {
    const text = readFileSync(CORDIS_PATH, 'utf8')
    const next = text.replace(/^(\s*)defaultPreset:.*$/m, '$1defaultPreset: ' + perm)
    if (next === text) return false
    writeFileSync(CORDIS_PATH, next, 'utf8')
    lastCordisPreset = perm
    return true
  } catch {
    return false
  }
}

/* Windows console-flash workaround: 平台的默认 runner(windows-acl,
   CreateProcessAsUserW 受限 token)会为每条受限命令新开一个 console 窗口——
   受限 token 下隐藏 console 会 STATUS_DLL_INIT_FAILED(0xC0000142),所以 SDK
   故意不用 CREATE_NO_WINDOW,而 runner 自身被 windowsHide 启动没有 console,
   子进程继承不到就在 Windows 里新建窗口闪一下。
   解决:win32 上把 sandbox 段注入 runnerCommand 指向 noop-runner.cjs(直接
   windowsHide spawn 命令,不建受限 token);文件写权限仍由进程内
   dsh-fs-sandbox 约束。其他平台保持默认链。幂等:已注入则跳过。 */
let lastSandboxWorkaround = false
function applySandboxWorkaround() {
  if (process.platform !== 'win32') return false
  if (lastSandboxWorkaround) return false
  try {
    const text = readFileSync(CORDIS_PATH, 'utf8')
    const want = JSON.stringify(process.execPath)
    /* 已注入且 execPath 一致(打包/开发环境切换后路径会变)→ 跳过 */
    if (text.includes(want) && text.includes('noop-runner.cjs')) {
      lastSandboxWorkaround = true
      return false
    }
    const to =
      "- id: sandbox\n" +
      "  name: '@deepseek-ai/dsh-sandbox-local'\n" +
      "  config:\n" +
      "    # win32 console-flash workaround: noop runner (see gateway.mjs applySandboxWorkaround)\n" +
      "    runnerCommand: [" + want + ", " + JSON.stringify(path.join(import.meta.dirname, 'noop-runner.cjs')) + "]\n" +
      "    runnerFailureSignatures: ['noop-runner:']\n"
    /* 整体替换 sandbox 段(到 sandbox-policy 前),无论是否已有 config */
    const start = text.indexOf('- id: sandbox\n')
    const end = text.indexOf('- id: sandbox-policy', start)
    if (start < 0 || end < 0) return false
    const next = text.slice(0, start) + to + text.slice(end)
    if (next === text) return false
    writeFileSync(CORDIS_PATH, next, 'utf8')
    lastSandboxWorkaround = true
    return true
  } catch {
    return false
  }
}

/* 中断一次运行。
   - 带 cancelTag（会话 agent:<id> / 节点 id / assist）：只关这一次运行占用的那台运行时；
     查不到就什么都不关。绝不能按 workspace 扫，否则同工作目录的其它会话会被一起打断
     （「停一个会话 → 所有会话全断」就是这么来的）。
   - 只有不带 tag 的兜底调用（旧语义 / 未登记 handle）才按 workspace 关闭。 */
async function cancelRuntime(workspace, cancelTag) {
  const tag = cancelTag == null ? '' : String(cancelTag)
  if (tag) {
    const set = tagToKey.get(tag)
    if (!set || !set.size) {
      tagToKey.delete(tag)
      /* 还没占上运行时(正在起机)→ 记一笔，等它占到位立刻自毁 */
      if (activeRunTags.has(tag)) wantCancelTag(tag)
      return false
    }
    tagToKey.delete(tag)
    let closed = false
    for (const k of Array.from(set)) {
      /* 用户取消优先于保活窗口:这一轮不要了,续跑候选标记一并摘掉,
         closeRuntimeByKey 的候选豁免就不会挡住这次关闭 */
      clearResumeCandidate(k)
      if (await closeRuntimeByKey(k)) closed = true
    }
    return closed
  }
  let closed = false
  for (const k of Array.from(runtimes.keys())) {
    if (!k.startsWith(String(workspace || '') + '|')) continue
    /* 同 workspace 兜底全关(旧语义 / 未登记 handle):同样先摘候选标记再关 */
    clearResumeCandidate(k)
    if (await closeRuntimeByKey(k)) closed = true
  }
  return closed
}

// ── plugin management ────────────────────────────────────────────────────────

function readRows() {
  // cordis.yml is a plain row list; the user-plugin section lives after the
  // marker comment. Rows before the marker belong to the shipped composition.
  const text = readFileSync(CORDIS_PATH, 'utf8')
  const marker = USER_PLUGIN_MARKER
  const idx = text.indexOf(marker)
  const shipped = idx === -1 ? text : text.slice(0, idx)
  const userPart = idx === -1 ? '\n' : text.slice(idx)
  return { shipped, userPart, marker }
}

/* 运行时组合里可在设置中挂载/卸载的非核心行(其余 shipped 行为引擎核心,只读)。
   平台条件行(disabled: !!js)即使列入此处也不允许手动切换。 */
const OPTIONAL_RUNTIME_IDS = new Set([
  'llm-pi-ai',
  'web', 'web-search-deepseek', 'tool-web',
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent', 'tool-subagent-fork', 'tool-subagent-report',
  'tool-todo', 'tool-goal',
  'token-meter', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'plan-mode', 'commands', 'command-feedback', 'command-goal',
  'goal', 'goal-round-driver',
  'agent-instructions', 'skill', 'skill-filesystem', 'tool-skill',
  'spill-local', 'spill-policy', 'timeout-policy', 'session-checkpoint-policy',
  'repeat-tool-reminder', 'tool-jobs',
])

/* 内置但允许完整卸载的套装：设置里可「移除」（删除组合行 + 插件目录）。
   默认随发行版关闭（cordis.yml 静态 disabled: true），需要时用户可挂载或卸载。 */
const REMOVABLE_BUNDLED_IDS = new Set([
  'dsh-router-standard',
])

function isBundledPluginName(name) {
  return /^\.\.?[/\\]/.test(String(name || ''))
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function readTextSafe(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

function parsePresetYml(text) {
  const name = (text.match(/^name:\s*(.+)$/m) || [])[1]
  const desc = (text.match(/^description:\s*(.+)$/m) || [])[1]
  const strip = (s) => String(s || '').replace(/^["']|["']$/g, '').trim()
  return { title: strip(name), description: strip(desc) }
}

/* Resolve package.json / preset.yml next to a plugin entry.
   Never use the gateway's own package.json for `./foo.mjs` rows. */
function lookupPkgDir(name) {
  const n = String(name || '').trim()
  if (!n) return { dir: '', pkg: null }
  const gatewayRoot = path.resolve(GATEWAY_DIR)
  if (/^\.\.?[/\\]/.test(n)) {
    const abs = path.resolve(GATEWAY_DIR, n)
    let dir = abs
    try {
      if (statSync(abs).isFile()) dir = path.dirname(abs)
    } catch {
      return { dir: '', pkg: null }
    }
    let cur = dir
    for (let i = 0; i < 5; i++) {
      if (path.resolve(cur) === gatewayRoot) break
      const pj = path.join(cur, 'package.json')
      if (existsSync(pj)) return { dir: cur, pkg: readJsonSafe(pj) }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return { dir: path.resolve(dir) === gatewayRoot ? '' : dir, pkg: null }
  }
  const pkgRoot = pkgRootName(n)
  if (!pkgRoot) return { dir: '', pkg: null }
  const userRoot = userPluginsRoot()
  const candidates = []
  if (userRoot) candidates.push(path.join(userRoot, 'node_modules', pkgRoot, 'package.json'))
  candidates.push(path.join(GATEWAY_DIR, 'node_modules', pkgRoot, 'package.json'))
  for (const pkgPath of candidates) {
    if (existsSync(pkgPath)) {
      return { dir: path.dirname(pkgPath), pkg: readJsonSafe(pkgPath) }
    }
  }
  return { dir: '', pkg: null }
}

function resolvePluginMeta(name) {
  const { dir, pkg } = lookupPkgDir(name)
  let title = ''
  let description = pkg ? String(pkg.description || '').trim() : ''
  const version = pkg ? String(pkg.version || '') : ''
  const presetCandidates = []
  if (dir) {
    presetCandidates.push(path.join(dir, 'preset.yml'))
    presetCandidates.push(path.join(path.dirname(dir), 'preset.yml'))
  }
  for (const pp of presetCandidates) {
    if (!existsSync(pp)) continue
    const pre = parsePresetYml(readTextSafe(pp))
    if (pre.title) title = pre.title
    if (pre.description) description = pre.description
    break
  }
  return {
    title,
    description: description.slice(0, 800),
    version,
  }
}

function isUsefulComment(s) {
  const t = String(s || '').trim()
  if (t.length < 8) return false
  if (/^https?:\/\//i.test(t)) return false
  if (/ESM cannot import/i.test(t)) return false
  if (/^Bundled optional suite/i.test(t)) return false
  return true
}

/* Associate `#` comments immediately above each `- id:` row (blank / `──` resets). */
function parsePluginRows(text) {
  const lines = String(text || '').split(/\r?\n/)
  const rows = []
  let pending = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (/^#\s*──/.test(trimmed)) {
      pending = []
      i += 1
      continue
    }
    if (trimmed.startsWith('#')) {
      const c = trimmed.replace(/^#\s?/, '').trim()
      if (c) pending.push(c)
      i += 1
      continue
    }
    /* 0.2 的 cordis.yml 是 profile 补丁层：顶层 `- id:` 是「按 id 覆盖既有行」，
       新增行缩进在 `- insert:` 段之下。两种都算运行时可切换行，缩进不影响起止判定
       （start 与 end 用同一份缩进正则，插入行之间不会互相吞并）。 */
    const idm = line.match(/^(\s*)- id:(.*)$/)
    if (idm) {
      const rowStart = new RegExp('^' + idm[1] + '- id:')
      const id = idm[2].trim()
      const blockLines = [line]
      i += 1
      while (i < lines.length) {
        const nxt = lines[i]
        if (rowStart.test(nxt) || /^#\s*──/.test(nxt.trim())) break
        if (nxt.trim() === '') {
          let j = i + 1
          while (j < lines.length && lines[j].trim() === '') j += 1
          if (j >= lines.length || rowStart.test(lines[j]) || lines[j].trim().startsWith('#')) break
        }
        if (/^\s/.test(nxt) || nxt.trim() === '') {
          blockLines.push(nxt)
          i += 1
          continue
        }
        break
      }
      rows.push({ id, comments: pending.slice(), block: blockLines.join('\n') })
      pending = []
      continue
    }
    pending = []
    i += 1
  }
  return rows
}

/* 网关启动：从配置目录恢复用户插件段，并挂上 user node_modules */
function initUserPlugins() {
  try {
    syncUserPluginsFromHome()
    ensureFilePluginEntries()
  } catch (err) {
    try {
      process.stderr.write('initUserPlugins: ' + String((err && err.message) || err) + '\n')
    } catch { /* ignore */ }
  }
}
initUserPlugins()

function describePlugin(block, kind, extra = {}) {
  const namem = block.match(/^\s*name:\s*'([^']+)'/m)
  if (!namem) return null
  const idm = block.match(/^- id:\s*(\S+)/m)
  const id = String(extra.id || (idm && idm[1]) || (block.match(/^([^\n]*)/) || ['', ''])[1] || '').trim()
  const dynamic = /^\s*disabled:\s*!!js\b/m.test(block)
  const disabled = /^\s*disabled:\s*true\s*$/m.test(block)
  const core = kind === 'runtime' && (dynamic || !OPTIONAL_RUNTIME_IDS.has(id))
  const meta = resolvePluginMeta(namem[1])
  const purpose = (extra.comments || []).filter(isUsefulComment).join('\n').slice(0, 600)
  const description = (meta.description || purpose).slice(0, 800)
  return {
    id,
    name: namem[1],
    kind,
    core,
    disabled,
    toggleable: !core && !dynamic,
    removable: kind === 'user' && (!isBundledPluginName(namem[1]) || REMOVABLE_BUNDLED_IDS.has(id)),
    source: kind === 'runtime' || isBundledPluginName(namem[1]) ? 'app' : 'config',
    detail: block.trim().slice(0, 600),
    title: meta.title || id,
    description,
    purpose: purpose && purpose !== description ? purpose : '',
    version: meta.version || '',
  }
}

/* 完整清单:运行时内置插件(组合中的全部行)+ 用户/套装插件(含挂载状态) */
function listPlugins() {
  const { shipped, userPart } = readRows()
  const out = []
  for (const row of parsePluginRows(shipped)) {
    const p = describePlugin(row.block, 'runtime', row)
    if (p) out.push(p)
  }
  for (const row of parsePluginRows(userPart)) {
    const p = describePlugin(row.block, 'user', row)
    if (p) out.push(p)
  }
  return out
}

function findPlugin(pkg, id) {
  return listPlugins().find((p) => (id && p.id === id) || (!id && p.name === pkg))
}

function rewritePluginBlocks(mutator, opts) {
  const text = readFileSync(CORDIS_PATH, 'utf8')
  const first = text.search(/^- id: /m)
  if (first < 0) throw new Error('cordis.yml 无插件行')
  const head = text.slice(0, first)
  const blocks = text.slice(first).split(/^(?=- id: )/m)
  const next = blocks.map(mutator).join('')
  writeFileSync(CORDIS_PATH, head + next, 'utf8')
  if (!opts || opts.persist !== false) persistUserSection()
}

/* 通用行启停:在匹配行块增删 disabled: true(不碰 disabled: !!js 平台条件) */
function toggleUserRow(matchText, enabled) {
  const { shipped, userPart } = readRows()
  const lines = userPart.split('\n')
  const out = []
  let inTarget = false
  let added = false
  for (const line of lines) {
    if (/^\s*-\s+id:/.test(line)) {
      inTarget = false
      added = false
    }
    if (line.includes(matchText)) inTarget = true
    if (/^\s*disabled:\s*true\s*$/.test(line) && inTarget && enabled) continue
    out.push(line)
    if (inTarget && line.includes(matchText) && !enabled && !added) {
      out.push('  disabled: true')
      added = true
    }
  }
  writeFileSync(CORDIS_PATH, shipped + out.join('\n'), 'utf8')
  persistUserSection()
}

function setPluginEnabled(pkg, enabled, id) {
  const target = findPlugin(pkg, id)
  if (!target) throw new Error('未找到该插件')
  if (!target.toggleable) throw new Error('核心插件不能取消挂载')
  let found = 0
  rewritePluginBlocks((block) => {
    const idm = block.match(/^- id:\s*(\S+)/)
    const namem = block.match(/^\s*name:\s*'([^']+)'/m)
    const hit = id
      ? (idm && idm[1] === id)
      : (namem && namem[1] === pkg)
    if (!hit) return block
    found++
    if (/^\s*disabled:\s*!!js\b/m.test(block)) {
      throw new Error('该插件由平台条件控制，不能手动挂载/卸载')
    }
    if (enabled) return block.replace(/^\s*disabled:\s*true\s*\n/m, '')
    if (/^\s*disabled:\s*true\s*$/m.test(block)) return block
    return block.replace(/^(  name: '[^']+'\n)/m, "$1  disabled: true\n")
  })
  if (!found) throw new Error('未找到该插件')
}

/* cordis.yml（0.2 profile 补丁）里插入新行：补丁层里「未在包层出现的 id + name」就是新行，
   直接追加到文件末尾即可（但必须落在用户插件标记之前 —— 标记之后的行由
   syncUserPluginsFromHome 当用户行搬到配置目录，会从发行组合里消失）。 */
function appendInsertBlock(text, lines) {
  const body = lines.join('\n') + '\n'
  const markerIdx = text.indexOf(USER_PLUGIN_MARKER)
  if (markerIdx < 0) return text.endsWith('\n') ? text + body : text + '\n' + body
  const head = text.slice(0, markerIdx).replace(/\n+$/, '\n')
  const tail = text.slice(markerIdx)
  return head + body + tail
}

function addPluginRow(pkg) {
  const text = readFileSync(CORDIS_PATH, 'utf8')
  if (text.includes(`name: '${pkg}'`)) return
  const next = appendInsertBlock(text, [
    `- id: user-plugin-${Date.now().toString(36)}`,
    `  name: '${pkg}'`,
  ])
  writeFileSync(CORDIS_PATH, next, 'utf8')
  persistUserSection()
}

function removePluginRow(pkg) {
  const { shipped, userPart, marker } = readRows()
  const rest = userPart.startsWith(marker) ? userPart.slice(marker.length) : userPart
  const blocks = rest.split(/\n- id: /)
  const kept = blocks
    .filter((block, i) => {
      if (block.includes(`name: '${pkg}'`)) return false
      if (i === 0) return true // marker 头部，无插件行
      const firstLine = block.split('\n')[0].trim()
      return firstLine !== pkg // 兼容按 id 卸载
    })
    .map((block, i) => (i === 0 ? block : '- id: ' + block))
  writeFileSync(CORDIS_PATH, shipped + marker + kept.join('\n'), 'utf8')
  persistUserSection()
}

function normalizePluginSpec(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/dsh-routing-suite/i.test(s)) {
    return { kind: 'suite', install: s, name: s, raw: s }
  }
  const ghUrl = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\.git)?/i)
  if (ghUrl) {
    const repo = ghUrl[2].replace(/\.git$/i, '')
    return { kind: 'github', install: 'github:' + ghUrl[1] + '/' + repo, name: repo, raw: s }
  }
  if (/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    return { kind: 'github', install: s, name: s.slice(s.indexOf('/') + 1), raw: s }
  }
  if (/^https?:\/\/\S+\.tgz(\?|$)/i.test(s)) {
    return { kind: 'tgz', install: s, name: path.basename(s).replace(/\.tgz$/i, ''), raw: s }
  }
  if (isBundledPluginName(s) && existsSync(path.resolve(GATEWAY_DIR, s))) {
    return { kind: 'bundled', install: s, name: s.replace(/\\/g, '/'), raw: s }
  }
  if ((/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/')) && existsSync(s)) {
    return { kind: 'local', install: s, name: s, raw: s }
  }
  if (/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(s)) {
    return { kind: 'npm', install: s, name: s, raw: s }
  }
  return null
}

function depNames(pkgJson) {
  return new Set(Object.keys((pkgJson && pkgJson.dependencies) || {}))
}

function newDepName(before, after) {
  const b = depNames(before)
  for (const n of depNames(after)) {
    if (!b.has(n)) return n
  }
  return ''
}

function runPackageManager(args, cwd) {
  const workDir = cwd || ensureUserPluginsPkg() || GATEWAY_DIR
  return new Promise((resolve, reject) => {
    const tries = ['pnpm', 'npm']
    const attempt = (i) => {
      if (i >= tries.length) {
        reject(new Error('需要 pnpm 或 npm(随应用分发的 Node 22+ 环境)才能安装插件'))
        return
      }
      const cmd = tries[i]
      const child = spawn(cmd, args, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let errTail = ''
      child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800) })
      child.on('error', () => attempt(i + 1))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else {
          const err = new Error(`${cmd} 退出码 ${code}: ${errTail.slice(-300)}`)
          reject(err)
        }
      })
    }
    attempt(0)
  })
}

async function handlePluginAdd(pkg) {
  const spec = normalizePluginSpec(pkg)
  if (!spec) {
    return { ok: false, error: '插件名格式无效（支持 npm 包名、GitHub 地址、本地路径或 .tgz）' }
  }
  if (spec.kind === 'suite') {
    return {
      ok: true,
      restarted: false,
      plugins: listPlugins(),
      message: 'dsh-routing-suite 仅内置 router-standard；注入器与 router-spec 已从本应用移除。该预设默认不加载，可在插件列表中挂载/取消挂载或完整卸载',
    }
  }
  if (spec.kind === 'bundled') {
    addPluginRow(spec.name)
    await closeAllRuntimes()
    return { ok: true, restarted: true, plugins: listPlugins() }
  }
  const installRoot = ensureUserPluginsPkg() || GATEWAY_DIR
  let pkgJsonBefore = {}
  try {
    pkgJsonBefore = JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8'))
  } catch {}
  await runPackageManager(['add', spec.install, '--save-exact'], installRoot)
  let name = spec.name
  try {
    const pkgJsonAfter = JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8'))
    name = newDepName(pkgJsonBefore, pkgJsonAfter) || spec.name
  } catch {}
  linkUserPackagesIntoGateway()
  addPluginRow(name)
  await closeAllRuntimes()
  return { ok: true, restarted: true, plugins: listPlugins() }
}

async function handlePluginRemove(pkg) {
  const target = findPlugin(pkg) || findPlugin(undefined, pkg)
  const removableBundled = !!(target && target.id && REMOVABLE_BUNDLED_IDS.has(target.id))
  if (target && !target.removable) {
    return { ok: false, error: '内置套装插件只能取消挂载，不能移除' }
  }
  if (target && isBundledPluginName(target.name) && !removableBundled) {
    return { ok: false, error: '内置套装插件只能取消挂载，不能移除' }
  }
  if (!isBundledPluginName(pkg) && !/^[A-Za-z]:[\\/]/.test(pkg) && !pkg.startsWith('/')) {
    const installRoot = ensureUserPluginsPkg() || GATEWAY_DIR
    try { await runPackageManager(['remove', pkg], installRoot) } catch { /* 本地/套装行可能不在 package.json */ }
    /* 清理 gateway 下残留的用户包 junction（若仍指向已删目录） */
    const key = pkgRootName(pkg)
    if (key) {
      const link = path.join(GATEWAY_DIR, 'node_modules', key)
      try {
        if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link)
      } catch { /* ignore */ }
    }
  }
  removePluginRow(pkg)
  await closeAllRuntimes()
  if (removableBundled && target) {
    /* 完整卸载：删除随应用内置的插件目录（尽力而为；被占用/只读时仅移除组合行） */
    try {
      const abs = path.resolve(GATEWAY_DIR, target.name)
      let dir = abs
      try { if (statSync(abs).isFile()) dir = path.dirname(abs) } catch { /* ignore */ }
      const pluginsRoot = path.resolve(GATEWAY_DIR, 'plugins')
      if (dir.startsWith(pluginsRoot + path.sep) && existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }
  return { ok: true, restarted: true, plugins: listPlugins() }
}

// ── MCP servers (one @deepseek-ai/dsh-mcp-client row per server) ───────────────

const MCP_PKG = '@deepseek-ai/dsh-mcp-client'

function yamlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

function mcpList() {
  const { userPart } = readRows()
  const out = []
  for (const block of userPart.split(/\n\s*-\s+id:/).slice(1)) {
    if (!block.includes(MCP_PKG)) continue
    const g = (re) => {
      const m = block.match(re)
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
    }
    const argsMatch = block.match(/^\s*args:\s*(.+)$/m)
    out.push({
      serverName: g(/^\s*serverName:\s*(.+)$/m),
      transport: g(/^\s*transport:\s*(.+)$/m),
      command: g(/^\s*command:\s*(.+)$/m),
      url: g(/^\s*url:\s*(.+)$/m),
      args: argsMatch ? argsMatch[1].trim() : '',
      disabled: /^\s*disabled:\s*true\s*$/m.test(block),
    })
  }
  return out
}

function mcpAdd(cfg) {
  const { serverName, transport, command, args, url } = cfg
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(serverName || ''))) {
    throw new Error('serverName 需为 1-32 位字母/数字/下划线/短横线')
  }
  if (mcpList().some((s) => s.serverName === serverName)) {
    throw new Error('同名 MCP 服务器已存在')
  }
  const lines = [
    `\n- id: user-mcp-${Date.now().toString(36)}`,
    `  name: '${MCP_PKG}'`,
    '  config:',
    `    serverName: ${yamlStr(serverName)}`,
    `    transport: ${yamlStr(transport)}`,
  ]
  if (transport === 'stdio') {
    if (!String(command || '').trim()) throw new Error('stdio 传输需要 command')
    lines.push(`    command: ${yamlStr(command.trim())}`)
    const argList = (Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean))
      .map(yamlStr)
      .join(', ')
    if (argList) lines.push(`    args: [${argList}]`)
  } else {
    if (!/^https?:\/\//.test(String(url || ''))) throw new Error('HTTP 传输需要 http(s) url')
    lines.push(`    url: ${yamlStr(url)}`)
  }
  const { shipped, userPart, marker } = readRows()
  const rest = userPart.startsWith(marker) ? userPart.slice(marker.length) : userPart
  writeFileSync(CORDIS_PATH, shipped + marker + rest + lines.join('\n') + '\n', 'utf8')
  persistUserSection()
}

function mcpRemove(serverName) {
  const { shipped, userPart, marker } = readRows()
  const blocks = userPart.split(/\n- id: /)
  const kept = blocks
    .filter((block) => {
      if (block.includes(MCP_PKG) && block.includes(`serverName: ${yamlStr(serverName)}`)) return false
      return true
    })
    .map((block, i) => (i === 0 ? block : '- id: ' + block))
  writeFileSync(CORDIS_PATH, shipped + marker + kept.join(''), 'utf8')
  persistUserSection()
}

function mcpSetEnabled(serverName, enabled) {
  toggleUserRow(`serverName: ${yamlStr(serverName)}`, enabled)
}

// ── protocol loop ────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.id === undefined || typeof msg.method !== 'string') return
  const reply = (result, error) => out({ id: msg.id, ok: !error, result, error })
  void (async () => {
    try {
      switch (msg.method) {
        case 'status':
          reply({
            gateway: GATEWAY_VERSION,
            node: process.version,
            runtimes: runtimes.size,
            runtimeBin: RUNTIME_BIN,
            configPath: CORDIS_PATH,
          })
          break
        case 'providerCatalog':
          reply({
            /* DeepSeek 官方目录与「官方模型」清单(officialModels → 适配器
               llm-deepseek.models)同源:条目一律由 OFFICIAL_MODEL_KNOWN 生成,
               不再手写模型名(表内顺序即目录顺序,现行 id 在前)。
               运行时真下发/落盘的 id 是 deepseek-v4-flash,目录照此列出;能吃图的档
               照实标 input 含 image —— 目录说能吃图、运行时却按自身表把它判成纯文本
               (在凭据与网络之前就拒掉图片),正是这条目录必须消灭的分歧。
               旧别名 deepseek-flash 仍被运行时按别名组接受,故一并列出,不单独手写。 */
            deepseek: Object.entries(OFFICIAL_MODEL_KNOWN).map(([id, k]) => ({
              id,
              name: k.name || id,
              contextWindow: k.contextWindow || 0,
              api: 'openai-completions',
              baseUrl: 'https://api.deepseek.com',
              input: [...(k.inputModalities || ['text'])],
            })),
            piai: piAiCatalog(),
          })
          break
        case 'run':
          reply({ accepted: true })
          await handleRun(msg.params ?? {})
          break
        case 'pluginList':
          reply({ plugins: listPlugins() })
          break
        case 'pluginAdd':
          reply(await handlePluginAdd((msg.params ?? {}).pkg))
          break
        case 'pluginRemove':
          reply(await handlePluginRemove((msg.params ?? {}).pkg))
          break
        case 'pluginEnable':
        case 'pluginDisable': {
          const pkg = (msg.params ?? {}).pkg
          const pid = (msg.params ?? {}).id
          if ((typeof pkg !== 'string' || !pkg) && (typeof pid !== 'string' || !pid)) {
            reply(undefined, '缺少插件名')
            break
          }
          setPluginEnabled(pkg, msg.method === 'pluginEnable', pid)
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, plugins: listPlugins() })
          break
        }
        case 'mcpList':
          reply({ servers: mcpList() })
          break
        case 'mcpAdd': {
          mcpAdd(msg.params ?? {})
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'mcpRemove': {
          const serverName = (msg.params ?? {}).serverName
          if (typeof serverName !== 'string' || !serverName) {
            reply(undefined, '缺少 serverName')
            break
          }
          mcpRemove(serverName)
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'mcpSetEnabled': {
          const serverName = (msg.params ?? {}).serverName
          if (typeof serverName !== 'string' || !serverName) {
            reply(undefined, '缺少 serverName')
            break
          }
          mcpSetEnabled(serverName, !!(msg.params ?? {}).enabled)
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'cancel': {
          const p = msg.params ?? {}
          const closed = await cancelRuntime(p.workspace, p.cancelTag)
          reply({ ok: true, closed })
          break
        }
        case 'configProbe': {
          /* 只读自检：把某台 live runtime 的**生效装配**回给宿主/冒烟（行 id + config）。
             用途：0.2 把设置真源搬到 profile 补丁层后，「宿主写了文件」不等于「运行时读到了
             配置」；这枚方法让 test/smoke-settings.js 的「已并入：smoke-settings-profile-patch.js」段 对着真实运行时核对。
             { reqId? | runKey? } 定位 runtime；都不给 = 取最近建立的那台。没有 live
             runtime 回 { ok:false, reason:'no_runtime' }（绝不为此起新进程）。 */
          reply(await handleConfigProbe(msg.params ?? {}))
          break
        }
        case 'steer':
        case 'pause': {
          /* 运行中插话 / 暂停(宿主只在「本轮还在跑」时发):
             params = { reqId | cancelTag, sessionId?, text?|contentBlocks?(仅 steer) }
             → 网关按在途表(reqId → {runKey, cancelTag, sessionId})定位这一轮那台
             runtime 的 client,同步下发 session/steer / session/pause(10s 超时)。
             拿不到 runtime / 老运行时没有该方法 → 回 {ok:false, reason:'unsupported'},
             宿主据此把这句插话回落成排队消息(等本轮 done 再发),绝不因插话失败断会话。
             pause 成功后本轮以 done{paused:true} 收尾,且不会有 error(见 pausedRuns)。 */
          const p = msg.params ?? {}
          reply(await handleInflightRequest(msg.method === 'pause' ? 'session/pause' : 'session/steer', p))
          break
        }
        case 'mcpResources': {
          /* MCP 资源面（「扩展能力管理」里每台 MCP 服务器的资源清单 / 单条读取走它）：
             { action:'list'|'read', serverName, uri?, servers:[{serverName,transport,command,args,url,disabled}] }
             服务器配置由宿主回传（网关不自己读配置来源），连接按服务器名缓存在网关进程里。
             只发只读请求；失败一律回 { ok:false, error }，不抛到 stdio 外。见 mcp-resources.mjs。 */
          const p = msg.params ?? {}
          reply(await handleMcpResources(p))
          break
        }
        case 'speech': {
          /* 语音输入宿主面（对话输入框的录音按钮走它）：
             { workspace, action:'state'|'prepare'|'cancel'|'transcribe', providerId?,
               downloadSource?, language?, audio?(base64 WAV 16kHz 单声道 PCM16) }
             与 dsh 的 run 无关，任何时刻都能调：没有在途轮时会按需拉起这台工作区的
             语音运行时（见 handleSpeech）。失败一律回 error 文本（不抛到 stdio 外）。 */
          const p = msg.params ?? {}
          try {
            reply(await handleSpeech(p))
          } catch (err) {
            reply({ ok: false, error: (err && err.message) || String(err) })
          }
          break
        }
        case 'browser': {
          /* 浏览器宿主面（活动流面板 / 求助卡的真窗口与接管 / 实况视图全走它）：
             { action: 'status'|'open'|'stop'|'takeover'|'view', on?, sessionId?, method?, ... }
             本轮需求：'policy' 这条通道与域名名单机制一起删掉了（危险动作审批恒开，
             不再有可编辑的策略）。
             与 dsh 的 run 无关，任何时刻都能调；失败一律回 error 文本（不抛到 stdio 外）。 */
          const p = msg.params ?? {}
          const action = String(p.action || 'status')
          /* 界面触发的浏览器动作（真窗口 / 接管）属于**用户此刻看着的那条会话**：
             面板把会话号带上来，活动流条目就盖它的章（不带 / 老宿主不下发时保持旧口径，
             由 lastSessionId 或空串决定）—— 否则「我点了接管，活动里却没有这条」。 */
          if (p.sessionId) BrowserCtl.lastSessionId = String(p.sessionId)
          try {
            if (action === 'status') reply(BrowserCtl.status())
            /* 求助卡上的「用真窗口打开」= 用户亲手点的那一下：唯一会带窗口的一只（visible 缺省 true）。 */
            else if (action === 'open') reply(await BrowserCtl.open({ visible: p.visible !== false }))
            else if (action === 'stop') reply(await BrowserCtl.stop())
            else if (action === 'takeover') reply(BrowserCtl.takeover(!!p.on, p.sessionId))
            else if (action === 'view') {
              /* 实况视图（会话右边栏）：{ action:'view', method:'status'|'start'|'stop'|'input'|'mode', ... }
                 不申请驱动锁（只「看」与摆窗口）；帧走事件总线（type 'browser-frame'），
                 绝不落库、不进模型上下文。 */
              const r = await BrowserCtl.viewHandle(p)
              reply(r.result)
            }
            else reply(undefined, '未知的浏览器动作：' + action)
          } catch (e) {
            reply(undefined, String((e && e.message) || e))
          }
          break
        }
        case 'interact': {
          /* 渲染层回答提问 / 审批:按交互 id 路由回对应运行时的桥接连接 */
          const p = msg.params ?? {}
          const pending = bridgePending.get(p.id)
          if (!pending) {
            /* 这条交互已经不在(pending 被撤销 / 网关从没见过):回 ok+stale 而不是 error。
               error 会让渲染层以为"发送失败"而把卡片留在屏上,用户于是对着死卡反复点;
               stale 明确告诉它"这卡已经作废",渲染层据此撤卡并给出说明。 */
            reply({ ok: true, stale: true })
            diag(`interact stale id=${String(p.id || '')} kind=${String(p.kind || '')}`)
            break
          }
          bridgePending.delete(p.id)
          if (p.kind === 'abort') {
            /* 宿主拒绝提问等交互:桥接侧 reject,工具调用失败而非空应答 */
            try { pending.socket.write(JSON.stringify({ t: 'abort', id: p.id }) + '\n') } catch {}
          } else if (p.kind === 'question') {
            if (!Array.isArray(p.answers)) {
              reply(undefined, '缺少 answers')
              break
            }
            try { pending.socket.write(JSON.stringify({ t: 'answer', id: p.id, answers: p.answers }) + '\n') } catch {}
          } else if (p.kind === 'approval') {
            const ok = ['allowed-once', 'rejected'].includes(p.outcome)
            if (!ok) {
              reply(undefined, 'outcome 非法')
              break
            }
            try { pending.socket.write(JSON.stringify({ t: 'outcome', id: p.id, outcome: p.outcome }) + '\n') } catch {}
          } else if (p.kind === 'canvas') {
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'canvas-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else if (p.kind === 'db') {
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'db-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else if (p.kind === 'facts') {
            /* AI 事实库工具（mtnode_facts）：宿主按本轮绑定画布读写本画布的 ai-facts.json
               （命中计数与淘汰也在宿主）。与 canvas / db 同形状：宿主失败＝ok:false + error
               文本（例如没有绑定画布），运行时工具以失败收场，会话不中断。 */
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'facts-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else if (p.kind === 'lt') {
            /* 长周期任务状态工具（lt_state）：run 与图状态的存放真源都在宿主。
               与 canvas / db 同一形状；非长任务轮由宿主回错误文本，会话不中断。
               （原 lt_memory 已下线，长期记忆沉淀改走 facts＝mtnode_facts。） */
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'lt-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else if (p.kind === 'asset') {
            /* 素材库 / 截图工具（mtnode_assets）：宿主读完素材库条目、或拍完窗口静帧后
               把绝对路径回传。与 canvas / db / lt 同一形状：宿主失败＝ok:false + error 文本，
               运行时工具以失败收场，会话不中断（例如窗口最小化时拍不到画面）。 */
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'asset-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else if (p.kind === 'browser') {
            /* 浏览器确认框 / 求助卡的回应（browser_* 工具面的问答通道）：
               outcome = allowed-once | rejected | released（求助类：用户已交还控制权）
                        | cancelled；answer 只在求助卡里带用户填的文字 / 选项。
               注意这里**不能**回 {t:'browser-result'} —— 那是工具调用的结果通道；
               这条交互只是浏览器动作闸门里的一次问答，结果由 BrowserCtl.handle 自己
               写回同一枚 id 的 browser-result。 */
            const item = bridgePending.get(p.id)
            if (!item || typeof item.resolve !== 'function') {
              reply({ ok: true, stale: true })
              diag(`interact stale browser id=${String(p.id || '')}`)
              break
            }
            bridgePending.delete(p.id)
            const outcome = String(p.outcome || p.answer || 'allowed-once')
            if (p.answerText || p.answer || p.selected) {
              item.resolve({ outcome: outcome === 'rejected' ? 'cancelled' : outcome, answer: p.answerText || p.answer || '', selected: p.selected || [] })
            } else item.resolve(outcome)
          } else if (p.kind === 'tool') {
            /* 用户工具节点 func call 结果：渲染层跑完节点图后回传输出值；
               失败（err 非空）→ ok:false + error 文本，运行时工具以失败收场，会话不中断 */
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'tool-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else {
            reply(undefined, 'kind 非法')
            break
          }
          reply({ ok: true })
          break
        }
        case 'shutdown':
          reply({ ok: true })
          /* MCP 资源面为「点开看一眼」临时起的服务器进程随网关一起收掉 */
          try { closeMcpResources() } catch {}
          await closeAllRuntimes()
          setTimeout(() => process.exit(0), 100)
          break
        default:
          reply(undefined, `unknown method: ${msg.method}`)
      }
    } catch (err) {
      reply(undefined, String((err && err.message) || err))
    }
  })()
})

process.stdin.on('end', () => {
  void closeAllRuntimes().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void closeAllRuntimes().then(() => process.exit(0))
})

/* 冒烟测试入口：设置下发（0.2 profile 补丁层）写入器 —— 只导出纯函数，不影响 stdio 主循环。 */
export { applySettings }
