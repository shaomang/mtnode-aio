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

const require = createRequire(import.meta.url)
const RUNTIME_BIN = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
const CORDIS_PATH = path.resolve(import.meta.dirname, 'cordis.yml')
const GATEWAY_DIR = import.meta.dirname
const GATEWAY_VERSION = '0.1.0'
/* 池化上限：仅回收空闲 runtime。有在途 run 的永不踢掉，可短暂超过此数。 */
const MAX_RUNTIMES = 6
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
    'You are the agent engine inside MTNode, a visual AI-workflow desktop app: a node canvas ordinary users build and re-run. Finish concrete content and file tasks — read and write files, search the web, run commands when needed, and edit the canvas with mtnode_canvas_get / mtnode_canvas_edit / mtnode_app. Division of labour: field names, enums, port numbering and @-reference syntax are documented in the descriptions of those tools themselves — that is their only source, so read the tool description instead of guessing, and call mtnode_canvas_get before editing. Read the canvas cheaply: detail "standard" (the default) plus ids / sections / bodyLimit; ask for detail:"full" only when you truly need complete bodies or rows. For any canvas discipline, load the matching built-in skill with the skill tool and follow it: mtnode-dev-architect (dev nodes / project module blocks), mtnode-canvas-batch-safety (batch runs + text-to-image), mtnode-canvas-layout-ux (marks, zones, control nodes, tidying a layout), mtnode-media-gen-nodes (music / speech / video backends), mtnode-db-facts (a wired database replica), mtnode-grill-me (ask the whole frontier before building). Behaviour that stays yours: keep text processing separate from image→text — a vision or agent node turns pixels into text, then pure-text nodes consume that text so language steps can use a better model; use mtnode_vision for mid-task pixel reading instead of stuffing images into the prompt; when the user asks for a workflow, build an editable left-to-right pipeline they can re-run with a control ▶ node rather than doing everything yourself; for anything beyond a handful of nodes plan with kind "task" nodes first instead of dumping a mixed graph; for per-item batch prefer ordinary proc_text / proc_image over smart nodes; when you write the prompt/task of a node and it must use the content of another node, reference it as @Title instead of pasting the body of that node inline (a material/asset node is referenced by its entry title, never by its own node title — syntax and the global-broadcast conditions are in the mtnode_canvas_edit description); treat tool receipts (created / updated / warnings) as the only proof of what happened — never invent node titles or claim results that are not in the receipt; work step by step, say what you are doing, and end with a clear, complete result.',
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

/* rollback journal 的迟到暂存表:runtime key -> 帧数组(按时间先后)。
   run 结束(或本就没有在途 run)后,运行时仍在往桥里推 journal 帧
   (后台 job、子代理收尾),这些帧没有 reqId 可挂,先落这里,
   渲染层用 rollbackDrain 按 sessionId/roundId 取回。
   每 key 上限 2000 条(超出丢最旧),整表最多 32 个 key。 */
const JOURNAL_BUFFER_LIMIT = 2000
const JOURNAL_BUFFER_KEYS = 32
/** @type {Map<string, any[]>} */
const journalBuffers = new Map()
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

/* 登记一次运行对 runtime 的占用(同步完成,中间不 await,避免并发 run 抢同一台)。
   sessionId 在登记时就带上:真实轮的 session 由网关铸造(handleRun 的 runSession),
   所以第一帧交互到达前归属判据已经完整,不存在「先放行再补票」的空窗。 */
function claimRuntime(key, reqId, cancelTag, sessionId) {
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
      /* 本轮预热轮('ok')的 session,起机预热时补记(见 handleRun);仅用于日志分类 */
      warmSession: '',
    })
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

/* ── rollback: 回合开合与 journal 路由 ─────────────────────────────────────
   journal 的归属必须精确到「哪一轮」,而投递时机靠不住(迟到帧),所以盖章的是
   运行时内的插件:gateway 在 run 开始时向该 runtime 的桥推 {t:'begin'},
   结束时推 {t:'end'},插件把 begin 的 roundId 当作进程级 current round
   (一个 runtime 同时只有一个在途 run,由 keyToReqId 保证,故进程级变量安全)。 */

/* 向一台 runtime 的全部桥连接(bridge / canvas / db / journal 插件各一条 socket)
   推一帧。未知 t 的接收方会自行忽略,因此广播比挑连接更稳。 */
function bridgeBroadcast(key, frame) {
  const b = bridgeServers.get(key)
  if (!b || !b.sockets || !b.sockets.size) return false
  let line = ''
  try { line = JSON.stringify(frame) + '\n' } catch { return false }
  let sent = false
  for (const s of b.sockets) {
    try { s.write(line); sent = true } catch { /* 连接已断 */ }
  }
  return sent
}

/* sid → 目录名的**单一真源**净化式子:rollback journal 目录与「会话是否可续跑」的日志
   查找都走它。两处各写一遍迟早会漂移(journal 记在 A 目录、日志查到 B 目录),故只留
   这一份。网关自铸的 id 本就是 ASCII(`session-<uuid hex>`),净化对它恒等;路径分隔符等
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

/* journal 目录约定:<DSH_HOME>/rollback/<sessionId>。渲染层本来就持有 dshHome 与
   sessionId,用同一式子反推路径即可;sessionId 做文件名净化后两边才一致。 */
function rollbackDirFor(dshHome, sessionId) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim()
  const sid = normSessionId(sessionId)
  if (!home || !sid) return ''
  const dir = path.join(home, 'rollback', sid)
  /* 建目录失败不阻断运行:插件侧自行降级为不落盘 */
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return dir
}

function bufferJournal(key, data) {
  let arr = journalBuffers.get(key)
  if (!arr) journalBuffers.set(key, (arr = []))
  arr.push(data)
  if (arr.length > JOURNAL_BUFFER_LIMIT) arr.splice(0, arr.length - JOURNAL_BUFFER_LIMIT)
  while (journalBuffers.size > JOURNAL_BUFFER_KEYS) {
    const oldest = journalBuffers.keys().next().value
    /* 仍在途的 key 不丢:它的迟到帧只是暂时无处可去 */
    if (keyToReqId.has(oldest)) break
    journalBuffers.delete(oldest)
  }
}

/* journal 帧原样往外投,只剥掉用于路由的 t:gateway 不猜内容、不重组载荷,
   插件写什么渲染层就收到什么。 */
function journalPayload(m) {
  const data = {}
  for (const k of Object.keys(m)) if (k !== 't') data[k] = m[k]
  return data
}

/* 插件盖的章在哪都认:帧顶层,或帧自带的 data 里(两种写法都不用改 gateway)。 */
function journalField(d, name) {
  if (!d || typeof d !== 'object') return ''
  const top = d[name]
  if (top !== undefined && top !== null) return String(top)
  const inner = d.data
  if (inner && typeof inner === 'object' && inner[name] !== undefined && inner[name] !== null) {
    return String(inner[name])
  }
  return ''
}

/* 取回暂存的 journal:按插件盖的章(sessionId/roundId)过滤,并可用 runtime
   key 或 workspace 前缀限定范围。默认取出即清;peek 只看不取。 */
function drainJournals(opts) {
  const p = opts && typeof opts === 'object' ? opts : {}
  const key = typeof p.key === 'string' ? p.key : ''
  const workspace = typeof p.workspace === 'string' ? p.workspace : ''
  const sessionId = p.sessionId == null ? '' : String(p.sessionId)
  const roundId = p.roundId == null ? '' : String(p.roundId)
  const peek = !!p.peek
  const taken = []
  for (const [k, arr] of Array.from(journalBuffers)) {
    if (key && k !== key) continue
    if (!key && workspace && !k.startsWith(workspace + '|')) continue
    if (!arr || !arr.length) {
      if (!peek) journalBuffers.delete(k)
      continue
    }
    const kept = []
    for (const d of arr) {
      if (sessionId && journalField(d, 'sessionId') !== sessionId) { kept.push(d); continue }
      if (roundId && journalField(d, 'roundId') !== roundId) { kept.push(d); continue }
      taken.push({ key: k, data: d })
    }
    if (peek) continue
    if (kept.length) journalBuffers.set(k, kept)
    else journalBuffers.delete(k)
  }
  return taken
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

/* SDK 握手预热:运行时组合的 settings 文档由 chokidar 异步载入,
   llm-pi-ai 的 mtnode/pi-ai 路由在启动约 0.5~1s 后才注册进适配器表。
   立即 initialize 会在首个请求报 "no adapter registered for provider ..."
   (deepseek-official 由 SDK 服务端自挂载,首试即成功)。失败仅重试该握手,
   运行时进程保持存活。 */
async function warmStartHarness(harness) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  harness.client.start()
  const params = {
    cwd: harness.cwd,
    provider: harness.provider,
    model: harness.model,
    ...(harness.maxTokens === undefined ? {} : { maxTokens: harness.maxTokens }),
  }
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await harness.client.initialize(params)
      return harness
    } catch (err) {
      lastErr = err
      if (!/no adapter registered/.test(String((err && err.message) || err))) throw err
      await sleep(400)
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

async function getRuntime(workspace, model, maxTokens, provider, apiKey, baseUrl, dshHome, envPatch, effort, webSearchApiKey, hostPersona, cancelTag, reqId, rollbackDir, pure, runSession, toolsJson, lean, noCanvas, hideTools) {
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
    (envPatch ? JSON.stringify(envPatch) : '') + '|ws:' + searchKey.slice(0, 8) + '|hp:' + personaHash + '|pure:' + (pureOn ? '1' : '0') + '|tl:' + tlHash + '|lean:' + (leanOn ? '1' : '0') + '|nc:' + (noCanvasOn ? '1' : '0') + '|hx:' + hxHash,
    effort,
  )
  const key = pickRuntimeKey(baseKey, cancelTag)
  const existing = runtimes.get(key)
  if (existing) {
    existing.order = ++runtimeOrder
    /* 复用也要先占住:一旦返回给 handleRun,中间让出事件循环就会被并发 run 抢走 */
    claimRuntime(key, reqId, cancelTag, runSession)
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
  if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl
  else delete env.DEEPSEEK_BASE_URL
  delete env.DSH_PERMISSION_MODE
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
  const tag = claimRuntime(key, reqId, cancelTag, runSession)

  /* 交互桥:每个运行时独占一个 localhost 端口。bridge + canvas 插件各连一条
     socket,按帧上的 id 把回答写回对应连接。 */
  const bridgeState = { server: null, sockets: new Set() }
  const bridgePort = await new Promise((resolve, reject) => {
    const server = createServer((s) => {
      bridgeState.sockets.add(s)
      socketToKey.set(s, key)
      let buf = ''
      s.on('data', (d) => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          let m
          try { m = JSON.parse(line) } catch { continue }
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
        abortBridgePending(key, s)
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
  /* rollback:journal 落盘目录。同一配置档被不同会话复用同一台 runtime 时,
     env 只反映建桥那次传入的目录,所以 begin 帧再带一次 dir,插件以帧为准。 */
  if (rollbackDir) env.MTNODE_ROLLBACK_DIR = rollbackDir
  else delete env.MTNODE_ROLLBACK_DIR
  /* 思考强度生效档:经 env 下达给运行时 mtnode-effort 插件(在 agent/request waterfall
     上逐步把档位提案进模型请求)。settings.yaml 的 llm-deepseek.reasoningEffort 只留
     兜底默认(见 applySettings),档位切换只冷起新 runtime(档位在 runtime key 里),
     不再触发 settings 热重载。effort 参数由 handleRun 传入归一后的 runEffort。 */
  if (effort) env.MTNODE_EFFORT = String(effort)
  else delete env.MTNODE_EFFORT
  bridgeServers.set(key, bridgeState)

  try { linkUserPackagesIntoGateway() } catch { /* best-effort */ }

  const entry = { order: ++runtimeOrder }
  entry.harness = (async () => {
    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [RUNTIME_BIN, CORDIS_PATH],
        cwd: workspace,
        env,
      },
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
function onBridgeFrame(key, m, socket) {
  if (!m || typeof m !== 'object') return
  /* journal 帧不是请求/应答:不进 bridgePending、不要求 id、不回 abort。
     有在途 run → 顺着事件流直接投给渲染层;无在途(后台 job / 子代理迟到)
     → 落 per-key 环形缓冲,等 rollbackDrain 取回。轮次归属由插件盖章决定,
     这里只按「此刻有没有人听」选投递通道。 */
  if (m.t === 'journal') {
    const data = journalPayload(m)
    const claim = claimOf(key)
    if (claim) out({ event: { reqId: claim.reqId, type: 'journal', data } })
    else bufferJournal(key, data)
    return
  }
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
  if (m.t !== 'question' && m.t !== 'approval' && m.t !== 'canvas' && m.t !== 'db' && m.t !== 'tool') return
  const claim = claimOf(key)
  /* 归属校验:交互帧一律自带发起轮的 session id(question/approval 来自 bridge-plugin,
     canvas/db 来自 canvas-plugin/db-plugin、tool 来自 tools-plugin 的 exec agent),
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

function mapNotification(n, emit, resumeCtx) {
  if (n.method === 'session.event') {
    const ev = n.params.event
    if (!ev) return
    switch (ev.type) {
      case 'assistant/chunk': {
        const c = ev.data && ev.data.chunk
        if (!c) return
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
        else if (c.type === 'block-end') {
          /* 正文块收尾 → say-end,前端据此切段(一个 turn/step/index 一段)。
             思考块 / 工具块收尾不发,事件名与新字段都不动老语义。 */
          const blk = c.block || (ev.data && ev.data.block) || {}
          if ((blk.type || c.blockType) === 'text') emit('say-end', { ...meta })
        }
        /* usage 不在此处上报:handleRun 的统计分支会带上 provider/model 归属后再 emit,
           否则客户端无法按模型分别累计 token */
        return
      }
      case 'tool/call': {
        const d = ev.data
        if (d)
          emit('tool', {
            callId: d.callId ?? '',
            turn: d.turn ?? 0,
            step: d.step ?? 0,
            name: d.name ?? d.tool ?? '',
            args: d.arguments ?? null,
          })
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
        /* 全量透传其余会话事件(permission/preset、approval/* 等) */
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
    permissionPreset, webSearchApiKey, hostPersona, cancelTag, rollback, pure, tools,
    lean, noCanvas, hideTools,
    resumeSession,
  } = params
  const emitOut = (type, data) => out({ event: { reqId, type, data } })
  /* 失败报文收集:通知流里报过的 error(message,如 turn/end reason error 的 429/5xx)
     与 catch 的 rawMessage 都收进来,finally 收尾时据此给失败轮 runtime 打
     「续跑候选」保活标记(见 markResumeCandidate)。只有 error 事件会写它,
     其余事件原样透传,语义不变。 */
  let runErrorMsg = ''
  const emit = (type, data) => {
    if (type === 'error' && data && typeof data.message === 'string' && data.message) {
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
  /* 回合开合:rollback = {sessionId, roundId}(渲染层每轮 run 生成)。
     dir 按约定算给运行时插件写 journal;begin/end 让插件给这个进程
     当前这一轮盖章,迟到帧靠章而不是靠投递时刻归属。 */
  const rb = rollback && typeof rollback === 'object' ? rollback : null
  const rbSession = rb ? String(rb.sessionId || '').trim() : ''
  const rbRound = rb ? String(rb.roundId == null ? '' : rb.roundId).trim() : ''
  const rollbackDir = rbSession ? rollbackDirFor(dshHome, rbSession) : ''
  const roundOpen = !!(rbSession || rbRound)
  /* begin 真的推出去了吗(桥可能还没连上):只有推过才需要补 end */
  let roundBegun = false
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
    /* 旧 id 归一(sketch → lean):预设文本按现名查表,否则历史会话会静默回落 standard */
    const presetId = normalizePresetId(preset)
    /* 目录同源服务商(如 opencode-go)映射回目录路由名,与 settings 注册一致 ——
       先定路由:思考档的归一化按路由能力表进行(deepseek-official 固定夹紧)。 */
    const route = routeOfProvider(provider, Array.isArray(mtnodeProviders) ? mtnodeProviders : [])
    /* 思考档一律沿用宿主设置(预设不压档)。归一化收敛在 reasoning-effort.mjs(codex
       reasoning_effort_for_request 式):旧档 off/none/无/空 → high;按路由能力夹紧
       (不支持 → 同侧最近低档 → high 兜底,永不硬失败)。同一个 runEffort 三处共用:
       settings 只写兜底默认(见 applySettings)、runtime key(换档冷起新运行时)、
       env MTNODE_EFFORT(运行时 mtnode-effort 插件按模型能力再夹一次)。 */
    const rawEffort = String(effort ?? '').trim().toLowerCase()
    const runEffort = effortForRoute(rawEffort, route)
    const settings = applySettings(dshHome, runEffort, mtnodeProviders, permissionPreset, hostPersonaText)
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
      webSearchApiKey, hostPersonaText, cancelTag, reqId, rollbackDir, pureFlag, runSession, toolsJson,
      leanFlag, noCanvasFlag, hideTools,
    )
    runKey = rt.key
    /* 占用成功 = 本轮的 session 归属已经钉死,第一时间报给宿主。
       宿主只有拿到这个 id 才可能在崩溃/断线后点名续跑(resumeSession),所以必须在
       起真实轮之前、而不是等 done 才说;resumed 表示这是沿用上一轮的旧会话。
       运行时若自行另铸 id(版本漂移),首条 session.event 改判权威 id 时会再 emit 一次。 */
    emit('session', { sessionId: sessionOut, resumed })
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
    /* 开回合:等 harness 就绪再推 —— 运行时还在起机时桥连接尚未建立,
       begin 丢了这一轮就没人盖章(宁缺勿错:无章的迟到帧走环形缓冲)。 */
    if (roundOpen) {
      roundBegun = bridgeBroadcast(runKey, {
        t: 'begin', sessionId: rbSession, roundId: rbRound, dir: rollbackDir,
      })
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
            }
          }
        }
        mapNotification(n, emit, { resumed, sid: resumeWanted })
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
              const bucket = modelBucket()
              const u = {
                inputTokens: Number(c.usage.inputTokens) || 0,
                outputTokens: Number(c.usage.outputTokens) || 0,
                cacheReadTokens: Number(c.usage.cacheReadTokens) || 0,
                cacheWriteTokens: Number(c.usage.cacheWriteTokens) || 0,
                reasoningTokens: Number(c.usage.reasoningTokens) || 0,
              }
              stats.inputTokens += u.inputTokens
              stats.outputTokens += u.outputTokens
              stats.cacheReadTokens += u.cacheReadTokens
              stats.cacheWriteTokens += u.cacheWriteTokens
              stats.reasoningTokens += u.reasoningTokens
              bucket.inputTokens += u.inputTokens
              bucket.outputTokens += u.outputTokens
              bucket.cacheReadTokens += u.cacheReadTokens
              bucket.cacheWriteTokens += u.cacheWriteTokens
              bucket.reasoningTokens += u.reasoningTokens
              bucket.calls++
              const stepMs = stepStart ? t - stepStart : 0
              stats.llmMs += stepMs
              bucket.llmMs += stepMs
              /* 逐模型性能:TTFT 累计(本步采样值)+ 本次调用的预处理量(计费输入),
                 genMs = 本次 LLM 用时扣掉首 Token 等待 = 纯生成时间 */
              const ttft = stepTtft
              if (ttft > 0) {
                bucket.ttftMs += ttft
                bucket.ttftSamples++
              }
              bucket.prefillTokens +=
                u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
              bucket.genMs += Math.max(0, stepMs - ttft)
              stepStart = 0
              stepTtft = 0
              /* 逐次调用用量带模型归属下发:会话末尾的累计报告 Badge 靠它实时增长 */
              emit('usage', Object.assign({}, u, {
                provider: bucket.provider,
                model: bucket.model,
                at: t,
              }))
            }
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
            if (ev.type.startsWith('job/') && ev.type.endsWith('started')) stats.jobs++
        }
      },
    })
    emit('done', {
      finalResponse: result.finalResponse,
      metrics: buildMetrics(),
      /* done 也带上本轮权威 session id:宿主据此存档,崩溃/断线后才能点名续跑 */
      sessionId: sessionOut,
      resumed,
    })
    /* harness.run 正常收流但通知里报过错(如 turn/end reason error 的 429/5xx):
       宿主同样判本轮失败,并会在重发窗口点名续跑 —— 留同样的保活标记 */
    if (runErrorMsg) failForResume = runErrorMsg
  } catch (err) {
    const rawMessage = String((err && err.message) || err)
    const message = rawMessage.slice(0, 800)
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
    /* 运行时进程已死:清掉池里的僵尸 harness,下次 run 重新 spawn */
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
    /* 闭回合:先于解除占用推送,插件据此清空进程级 current round,
       之后的迟到 journal 帧就没有本轮的章了。 */
    if (roundBegun) {
      bridgeBroadcast(runKey, { t: 'end', sessionId: rbSession, roundId: rbRound })
    }
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
   - 可选用档 = low/medium/high/xhigh/max(对齐 pi-ai 能力集;无 off/minimal:
     off 在 agent 链上的语义是旧档「关思考」→ high,minimal 无消费方)。
   - 旧档 off/none/无/空 与非法值 → high(兜底默认,与历史 normalizeEffort 一致)。
   - DeepSeek 官方路由(llm-deepseek 适配器)能力 off/low/high/max → 可选用交集
     low/high/max,medium/xhigh 按「同侧最近低档」回退(medium→low, xhigh→high);
     目录/pi-ai 等其余路由按全档,模型级精确能力由运行时插件经 ctx.llm 解析后再夹。
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
const PERMISSION_PRESETS = [
  'mtnode-unattended',
  'read-only',
  'workspace-write',
  'danger-full-access',
  'mtnode-super-ask',
  'bongochat',
]
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

function applySettings(dshHome, effort, mtnodeProviders, permissionPreset, hostPersona) {
  const home = dshHome || process.env.DSH_HOME || ''
  const list = Array.isArray(mtnodeProviders) ? mtnodeProviders : []
  const envPatch = {}
  list.forEach((p, i) => {
    if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
    envPatch['MTNODE_KEY_' + (i + 1)] = String(p.apiKey || '')
  })
  if (!home) return { envPatch, changed: false }
  /* settings 的 llm-deepseek.reasoningEffort 只保留兜底默认(DEFAULT_EFFORT = high):
     思考档已改经 env MTNODE_EFFORT + 运行时 mtnode-effort 插件逐步下发(见上方
     EFFORTS 注释段)——档位切换不再写 settings、不再触发热重载与多余 450ms 等待,
     runtime 隔离由 runtime key(含档位)承担。llm-deepseek 适配器省略 reasoningEffort
     时本身也回退 high,与本默认一致,插件缺席时行为与接入前一字不变。 */
  const eff = DEFAULT_EFFORT
  /* 权限预设:dsh permission-presets 的 defaultPreset,热重载后对新会话生效 */
  const perm = PERMISSION_PRESETS.includes(permissionPreset) ? permissionPreset : 'mtnode-unattended'
  const persona = String(hostPersona || '').trim()
  const hash = eff + '|' + perm + '|' + JSON.stringify(list) + '|hp:' + persona
  if (hash === lastSettingsHash && home === lastSettingsHome) return { envPatch, changed: false }
  try {
    const provLines = []
    list.forEach((p, i) => {
      if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
      const cat = catalogIdOf(p)
      const route = cat || 'mtnode_' + (p.route || 'p' + (i + 1))
      provLines.push('    ' + route + ':')
      provLines.push('      apiKeyEnv: MTNODE_KEY_' + (i + 1))
      /* baseURL 无凭据间接层:直接写 URL(非机密),密钥仅经 env 引用 */
      provLines.push('      baseURL: ' + String(p.baseUrl).trim())
      /* 目录同源路由不写 api:模型级 api 以目录元数据为准(多协议目录如
         opencode-go 同时含 openai-completions 与 anthropic-messages);
         通用路由保留 api 声明(默认 openai-completions) */
      if (!cat) provLines.push('      api: ' + String(p.api || 'openai-completions'))
      provLines.push('      models:')
      for (const m of p.models || []) provLines.push('        - id: ' + m)
    })
    mkdirSync(home, { recursive: true })
    const settingsPath = path.join(home, 'settings.yaml')
    let rest = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    rest = stripYamlSection(rest, 'llm-deepseek')
    rest = stripYamlSection(rest, 'llm-pi-ai')
    rest = stripYamlSection(rest, 'permission')
    rest = stripYamlSection(rest, 'system-prompt')
    const parts = ['llm-deepseek:\n  reasoningEffort: ' + eff]
    if (list.length) parts.push('llm-pi-ai:\n  providers:\n' + provLines.join('\n'))
    parts.push('permission:\n  defaultPreset: ' + perm)
    if (persona) parts.push(yamlHostPersonaSection(persona))
    const txt = parts.join('\n') + (rest.trim() ? '\n' + rest.trim() : '') + '\n'
    writeFileSync(settingsPath, txt, 'utf8')
    lastSettingsHome = home
    lastSettingsHash = hash
    return { envPatch, changed: true }
  } catch {
    /* 尽力而为:写入失败不阻断任务,保留运行时默认档 */
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
    if (/^- id:/.test(line)) {
      const id = line.replace(/^- id:\s*/, '').trim()
      const blockLines = [line]
      i += 1
      while (i < lines.length) {
        const nxt = lines[i]
        if (/^- id:/.test(nxt) || /^#\s*──/.test(nxt.trim())) break
        if (nxt.trim() === '') {
          let j = i + 1
          while (j < lines.length && lines[j].trim() === '') j += 1
          if (j >= lines.length || /^- id:/.test(lines[j]) || lines[j].trim().startsWith('#')) break
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

function addPluginRow(pkg) {
  const { shipped, userPart, marker } = readRows()
  if (userPart.includes(`name: '${pkg}'`)) return
  const rest = userPart.startsWith(marker) ? userPart.slice(marker.length) : userPart
  const row = `\n- id: user-plugin-${Date.now().toString(36)}\n  name: '${pkg}'\n`
  writeFileSync(CORDIS_PATH, shipped + marker + rest + row, 'utf8')
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
            deepseek: [
              { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, api: 'openai-completions', baseUrl: 'https://api.deepseek.com', input: ['text'] },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, api: 'openai-completions', baseUrl: 'https://api.deepseek.com', input: ['text'] },
              { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1000000, api: 'openai-completions', baseUrl: 'https://api.deepseek.com', input: ['text', 'image'] },
            ],
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
        case 'rollbackDrain': {
          /* 取回「无在途 run」时暂存的 journal 帧(后台 job / 子代理迟到写入)。
             params: { key?, workspace?, sessionId?, roundId?, peek? }
             过滤按插件盖的章(sessionId/roundId);取出即清,peek=true 只看不取。
             返回 { entries: [{ key, data }] } ,时间先后次序。 */
          const entries = drainJournals(msg.params ?? {})
          reply({ entries })
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
