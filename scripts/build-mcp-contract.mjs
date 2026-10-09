/**
 * MTNode MCP 接口契约生成器（只读 · 离线）
 *
 * 产物：
 *   1) mcp-tools.json（项目根）—— 机器可读契约快照（工具参数表 / 资源清单 / 提示词清单）。
 *      为什么在根目录而不是 docs/：主进程 mcp-server.js 运行时要读它（tools/list 的描述正文
 *      是插件里的真源，不能抄第二份），而 build.json 的 files 是显式白名单、只有根目录这些
 *      条目会进安装包。人读的说明在 guides/mcp-server.md / guides/mcp-tools.md。
 *   2) mcp-tool-schemas.js（项目根）—— 主进程 MCP 服务端用的参数校验表（同样由本脚本写）。
 *
 * 为什么这样生成（而不是手写一份 MCP 侧 schema）：
 *   项目硬规矩是「参数机制只写在 dsh/gateway/*-plugin.mjs」。这里**不抄**参数表，而是把
 *   插件模块的 import 剥掉、用桩替掉 defineTool / register，真实调用 register()，
 *   把每个 defineTool({...}) 的 name / description / parameters 原样抓下来，再用
 *   官方 defineTool（网关 node_modules 里那份，与运行时**同一个函数**）算出它就是
 *   JSON Schema 的 parameters —— 于是「插件改了参数 → 契约与渲染层校验表一起变」，
 *   不需要任何人记得同步。
 *
 * 跑法：node scripts/build-mcp-contract.mjs [--check]
 *   --check：只比对，不写盘；不一致退码 1（冒烟用它）。
 *
 * 约束：只读插件源码与网关依赖；除上面两个产物外不写任何文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
const GATEWAY = path.join(ROOT, 'dsh', 'gateway')

/** 参与导出的插件（顺序 = 契约里的展示顺序）；不在这张表里的插件一律不导出。 */
export const MCP_PLUGIN_FILES = [
  'canvas-plugin.mjs',
  'db-plugin.mjs',
  'ai-facts-plugin.mjs',
  'longtask-plugin.mjs',
  'assets-plugin.mjs',
]

/** 每个工具归到哪一族（渲染层按族分派 op；见 renderer/mcp-bridge.js 的 MCP_TOOL_OPS）。 */
export const TOOL_FAMILY = {
  mtnode_canvas_get: 'canvas',
  mtnode_canvas_edit: 'canvas',
  mtnode_app: 'canvas',
  mtnode_vision: 'canvas',
  mtnode_db: 'db',
  mtnode_facts: 'facts',
  lt_state: 'lt',
  mtnode_assets: 'asset',
}

/* ── 从插件源码里抽 defineTool 规格（真跑 register，不解析对象字面量）──────────── */

/** 剥掉 import / export 关键字，保留其余源码原样（供 new Function 包成模块体执行）。 */
function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s+[^;\n]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^\s*export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
}

/**
 * 抓一个插件模块里所有 defineTool 规格。
 * @param {string} file 插件文件名（位于 dsh/gateway/）
 * @param {Function} defineTool 官方 defineTool（用来把 parameters 编译成 JSON Schema）
 */
function captureToolSpecs(file, defineTool) {
  const src = fs.readFileSync(path.join(GATEWAY, file), 'utf8')
  const specs = []
  /* 追加的尾巴在**模块作用域**里：插件把 defineTool 结果交给 apply() 内部的 register()，
     而 register 是局部常量，所以只能从 ctx.tools.register 这一头接 —— 用桩 ctx 调 apply()，
     被注册的每个工具都会过我们的 defineTool 桩，规格就此落地。 */
  const body = stripModuleSyntax(src) + '\n;try { __run(apply) } catch (e) { __fail(e) }\n'
  const stubDefine = (spec) => {
    /* 真 defineTool 会把 parameters 编译成「就是 JSON Schema」的形态 —— 要的就是编译结果，
       所以桩必须调真的那个（同一个函数、同一份语义），绝不自己写一套转换。 */
    const tool = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute() {
        return null
      },
    })
    specs.push({ name: String(spec.name || ''), description: String(spec.description || '').trim(), schema: tool.parameters })
    return tool
  }
  /* 形参名必须与插件 import 进来的名字逐字一致（剥掉 import 后它们就是自由变量）。 */
  const fn = new Function(
    'defineTool',
    '__run',
    '__fail',
    'createConnection',
    'randomUUID',
    'toolSchemaPropKey',
    'remapToolCallArgs',
    'isToolHidden',
    'hiddenToolsFromEnv',
    'HIDEABLE_TOOLS',
    body,
  )
  let firstError = null
  fn(
    stubDefine,
    (apply) => {
      if (typeof apply !== 'function') throw new Error(file + ' 里没有可调用的 apply(ctx)')
      apply({ tools: { register: (t) => t } })
    },
    (e) => {
      firstError = e
    },
    () => ({ on() {}, write() {}, end() {} }),
    () => '00000000-0000-4000-8000-000000000000',
    'inputSchema',
    (a) => a,
    () => false,
    () => new Set(),
    [],
  )
  if (!specs.length && firstError) throw firstError
  return specs
}

/* ── 资源 / 提示词清单（MCP 侧自有，不是插件真源）───────────────────────────── */

/**
 * resources：四类只读资源。
 * URI 只用 ASCII，避免第三方客户端对中文 URI 的转义差异；name/title 里才带中文。
 * kind 是给宿主（主进程 → 渲染层）认的取数口径。
 */
export const MCP_RESOURCES = [
  {
    uri: 'mtnode://canvases',
    name: 'canvases',
    title: '画布列表',
    kind: 'canvas-list',
    mimeType: 'application/json',
    description: '本机全部画布（id / 名称 / 节点数 / 是否当前打开）。',
  },
  {
    uriTemplate: 'mtnode://canvas/{canvas}/snapshot',
    name: 'canvas-snapshot',
    title: '画布快照',
    kind: 'canvas-snapshot',
    mimeType: 'application/json',
    description: '{canvas} 可为画布 id、精确名称或 current；默认 detail:"minimal"（纯节点索引）。',
  },
  {
    uriTemplate: 'mtnode://canvas/{canvas}/node/{node}',
    name: 'node-body',
    title: '节点正文',
    kind: 'node-body',
    mimeType: 'application/json',
    description: '{node} 可为节点 id 或唯一标题；返回该节点 detail:"full" 的正文（prompt / text / task / jscode / 参数表）。',
  },
  {
    uriTemplate: 'mtnode://skill/{name}',
    name: 'skill',
    title: '内置技能正文',
    kind: 'skill-body',
    mimeType: 'text/markdown',
    description: '内置技能 SKILL.md 正文（名称如 mtnode-canvas-edit-rules）。技能名清单见资源 mtnode://skills。',
  },
  {
    uri: 'mtnode://skills',
    name: 'skills',
    title: '内置技能清单',
    kind: 'skill-list',
    mimeType: 'application/json',
    description: '本机内置技能（名称 / 标题 / 描述 / 路径），供 mtnode://skill/{name} 使用。',
  },
]

/** prompts：三份模板，正文由 renderer/mcp-prompts.js 组装（那里能引用契约与资源 URI）。 */
export const MCP_PROMPTS = [
  {
    name: 'takeover-canvas',
    title: '接手画布',
    description: '让客户端先看清画布现状、再动手改：读图 → 认节点 → 用 canvas_edit 一次改完。',
    args: [{ name: 'canvas', description: '画布 id / 精确名称；省略 = 当前打开的画布', required: false }],
    builder: 'takeoverCanvas',
  },
  {
    name: 'build-workflow',
    title: '建工作流',
    description: '按一句话需求在画布上建一条可重跑的数据流（输入 → 处理 → 保存），含控制与分区。',
    args: [
      { name: 'goal', description: '这条工作流要做什么（一句话）', required: true },
      { name: 'canvas', description: '目标画布；省略 = 当前打开的画布', required: false },
    ],
    builder: 'buildWorkflow',
  },
  {
    name: 'review-canvas',
    title: '审阅画布',
    description: '只读审阅：读画布结构、指出断链 / 空参数 / 缺保存等硬问题，给出逐条修改建议（不改图）。',
    args: [{ name: 'canvas', description: '要审阅的画布；省略 = 当前打开的画布', required: false }],
    builder: 'reviewCanvas',
  },
]

/* ── 组装 + 写盘 ──────────────────────────────────────────────────────────── */

export async function buildContract() {
  const mod = await import(pathToFileURL(path.join(GATEWAY, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href)
  const defineTool = mod.defineTool
  if (typeof defineTool !== 'function') throw new Error('取不到官方 defineTool（' + GATEWAY + '）')

  const tools = []
  for (const file of MCP_PLUGIN_FILES) {
    for (const spec of captureToolSpecs(file, defineTool)) {
      if (!/^(mtnode_|lt_)/.test(spec.name)) continue
      tools.push({
        name: spec.name,
        description: spec.description,
        family: TOOL_FAMILY[spec.name] || 'other',
        source: 'dsh/gateway/' + file,
        inputSchema: spec.schema,
      })
    }
  }
  const names = tools.map((t) => t.name)
  for (const n of Object.keys(TOOL_FAMILY)) {
    if (!names.includes(n)) throw new Error('契约里缺少工具 ' + n + '（插件改动后忘了更新 TOOL_FAMILY？）')
  }
  return {
    generator: 'scripts/build-mcp-contract.mjs',
    note:
      '本文件由生成器产出，禁止手改。参数表真源 = dsh/gateway/*-plugin.mjs 的 defineTool 参数表；' +
      '改插件后重跑 `node scripts/build-mcp-contract.mjs`（test/smoke-mcp-server.js 会钉住一致性）。',
    protocol: { name: 'mtnode', version: 1 },
    tools,
    resources: MCP_RESOURCES,
    prompts: MCP_PROMPTS.map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.args,
      /* 构造器名：MCP prompts 的正文由 mcp-prompts.js 组装（那里能引用资源 URI 与工具名），
         这里只记"用哪个构造器"——客户端拿到的契约里不带它，见 mcp-server.js 的 promptList。 */
      builder: p.builder,
    })),
  }
}

/** 主进程校验表：工具名 → 输入 schema（校验 MCP 侧 args 后才下发）。 */
export function rendererSchemasModule(contract) {
  const map = {}
  for (const t of contract.tools) map[t.name] = t.inputSchema
  return (
    '/* 由 scripts/build-mcp-contract.mjs 生成，禁止手改。\n' +
    '   参数表真源 = dsh/gateway/*-plugin.mjs；改插件后重跑生成器（test/smoke-mcp-server.js 钉住一致性）。 */\n' +
    "'use strict';\n" +
    'module.exports.MCP_TOOL_SCHEMAS = ' +
    JSON.stringify(map) +
    ';\n'
  )
}

async function main() {
  const check = process.argv.includes('--check')
  const contract = await buildContract()
  const contractPath = path.join(ROOT, 'mcp-tools.json')
  const schemasPath = path.join(ROOT, 'mcp-tool-schemas.js')
  const nextContract = JSON.stringify(contract, null, 2) + '\n'
  const nextSchemas = rendererSchemasModule(contract)
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
  /* 比较按「行尾归一」口径：仓内是 LF，但 Windows 检出（core.autocrlf / .gitattributes）
     会把它读成 CRLF —— 按字节比会在 Windows 上恒报「不一致」，把真正的契约漂移淹掉
     （Linux / CI 上是绿的）。行尾不是契约的一部分；生成时依旧写 LF。 */
  const same = (a, b) => a !== null && a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
  const drift = []
  if (!same(read(contractPath), nextContract)) drift.push(path.relative(ROOT, contractPath))
  if (!same(read(schemasPath), nextSchemas)) drift.push(path.relative(ROOT, schemasPath))
  if (check) {
    if (drift.length) {
      console.error('[mcp-contract] 契约与生成结果不一致：' + drift.join('、'))
      console.error('[mcp-contract] 跑 `node scripts/build-mcp-contract.mjs` 重新生成。')
      process.exit(1)
    }
    console.log('[mcp-contract] OK：' + contract.tools.length + ' 个工具 / ' + contract.resources.length + ' 个资源 / ' + contract.prompts.length + ' 个提示词')
    return
  }
  fs.mkdirSync(path.dirname(contractPath), { recursive: true })
  fs.writeFileSync(contractPath, nextContract, 'utf8')
  fs.writeFileSync(schemasPath, nextSchemas, 'utf8')
  console.log('[mcp-contract] 已写出：' + path.relative(ROOT, contractPath) + ' · ' + path.relative(ROOT, schemasPath))
  console.log('[mcp-contract] 工具 ' + contract.tools.length + '：' + contract.tools.map((t) => t.name).join(', '))
}

/* 允许被 import（冒烟用 buildContract / MCP_* 常量），直接跑才执行 main */
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main().catch((e) => {
    console.error('[mcp-contract] 失败：' + ((e && e.stack) || e))
    process.exit(1)
  })
}