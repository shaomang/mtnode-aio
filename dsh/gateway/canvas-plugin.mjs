// MTNode canvas tools (runs INSIDE the dsh runtime process).
//
// Registers mtnode_canvas_get / mtnode_canvas_edit / mtnode_app so the agent can
// create, title, connect, @-reference, and auto-layout nodes. Mutations travel
// over the same localhost TCP bridge as bridge-plugin.mjs (port from
// MTNODE_BRIDGE_PORT). This file may import @deepseek-ai/dsh-tools (defineTool);
// dsh API churn stays inside dsh/.
//
// Protocol (newline-delimited JSON, extra to the question/approval frames):
//   plugin → gateway: {t:'canvas', id, sessionId, op:'get'|'edit'|'app'|'vision', params}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame we just sent)
//   gateway → plugin: {t:'canvas-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the tool call (exec.agent.id;
// in dsh an agent's id IS its session id). The gateway gates interaction frames on it
// (see gateway.mjs onBridgeFrame): a canvas confirmation belongs to the turn that asked
// for it, so a stamp that does not match the run in flight — a warm-up turn, a leftover
// background job or subagent from a previous run — is aborted instead of being shown.
// Unstamped frames are rejected too (fail closed): an orphaned 危险操作确认框 popping
// into the session the user is watching is a dead dialog whose answer goes nowhere.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hiddenToolsFromEnv } from './tool-visibility.mjs'

export const name = 'mtnode-canvas'
export const inject = ['tools']

const KINDS = [
  'input_text', 'input_image', 'input_audio', 'input_video', 'input_file', 'db_table', 'proc_text', 'proc_image', 'music_gen', 'tts_gen', 'video_gen', 'remotion',
  'save', 'save_text', 'save_image', 'save_pdf', 'split', 'merge', 'global', 'wait_file', 'timer',
  'delayer', 'sequencer', 'gate', 'splitter', 'counter', 'mutex',
  'agent_task', 'task', 'super', 'db_replica',
  'control', 'judge', 'net_recv', 'net_send', 'execute',
  /* 工具节点（＝super + tool:true 变体）/ 函数节点：右键「工具」菜单的两种计算节点 */
  'tool', 'function',
]

const NODE_LOCK =
  'CRITICAL — These canvas tools are ONLY for the global assistant (✦) and the agent-session view. When the run is a canvas AGENT NODE (kind agent_task, or proc_text with agent:true), the host REJECTS mtnode_canvas_get / mtnode_canvas_edit / mtnode_app. Do not call them from a node; read and write workspace files instead.\n\n'

/* ── 按运行裁剪工具负载（gateway 在 spawn 时注入的可见集标记）──
 * 每一次模型调用都把全部工具定义重发一遍（优化前实测：固定前缀 tools ≈ 98K 字符、空会话
 * 首步 32K token，且每一步都付），所以「这次运行根本用不上的工具」就该整个不注册。
 * 本文件里唯一判定点是 apply() 内的 register()（两个丢弃集合 + 一份规范隐藏名单）。
 * 取舍与实测见 docs/codex-agent-benchmark.md「本轮落地：Token 开销」。
 * 三个标记（lean: / nc: / hx:）都进 runtime key（gateway.getRuntime）：换档即冷起自己的
 * 运行时，绝不会出现「同一台运行时两种可见集」互相打爆提示缓存。名单真源见 tool-visibility.mjs。 */

/** 设置里的「精简工具负载」开关 → env（gateway.handleRun 按 run 参数注入）。 */
const LEAN_ENV = 'MTNODE_LEAN_TOOLS'
/** 画布智能节点（nodeLock）运行 → env：宿主本来就拒收画布工具，定义纯属白发。 */
const NO_CANVAS_ENV = 'MTNODE_NO_CANVAS'

/** env 真值口径（两个标记共用）：1 / on / true / yes，其余（缺席、空、非法）= 关。 */
function envFlagOn(key) {
  let raw = ''
  try {
    raw = String(process.env[key] || '').trim().toLowerCase()
  } catch {
    return false
  }
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

/* 开精简负载时不注册的「可选能力」工具：
   · mtnode_app    3,177 字符 —— 改名 / 选中 / 撤销重做 / 删除画布 / DSH 插件管理，
                    用户在界面里自己就能做，却每次模型调用都要跟着重发一遍；
   · mtnode_vision 1,544 字符 —— 首次调用必弹窗授权，多数会话整轮用不到。
   画布主干（canvas_get / canvas_edit）与 mtnode_db（接了数据库副本时事实的唯一真源）
   任何档位都保留。合计省约 4.7K 字符 ≈ 1.5K token/步。 */
const LEAN_DROP_WHEN_LEAN = new Set(['mtnode_app', 'mtnode_vision'])

/* 画布智能节点（agent_task / proc_text 智能模式）运行时不注册的画布工具：宿主侧
   applyCanvasOp / handleCanvasEvent 对 get / edit / app 一律直接拒绝
   （isCanvasNodeAgentRun），把这约 25.6K 字符（三件套实测）发过去只换来一次次撞不存在的工具。
   mtnode_vision 保留 —— 智能节点人设明确允许它识图（agentNodeCapabilityNote）。 */
const NODE_LOCK_DROP_CANVAS = new Set([
  'mtnode_canvas_get',
  'mtnode_canvas_edit',
  'mtnode_app',
])

const leanToolsOn = () => envFlagOn(LEAN_ENV)
const noCanvasToolsOn = () => envFlagOn(NO_CANVAS_ENV)

/* GET_DESC 只写「这张工具给什么 + 三档颗粒度各给什么 + 一句话指向技能」。
   每个参数的取法（ids / scope / sections / bodies / bodyLimit）唯一真源是下面的 parameters
   表，此处不再抄第二份；节点级字段清单同样不抄 —— 它是按 kind 生成的，抄在这里既每轮重发
   又会随实现漂移（旧版那句「默认就带 prompt/task/goal」早就与实现相反了）。
   开发节点「功能色卡」也不在描述里硬拷一份：它是 detail:"standard" 返回的 devFuncColors
   列表（真源 renderer/app-devnode.js 的 DEV_FUNC_COLORS），要建开发块时按需取。 */
const GET_DESC =
  NODE_LOCK +
  'Read the canvas this run belongs to: workflow identity + the nodes in the current task / super scope, plus marks / wires / groups / trees / app references when asked. Always read before editing.\n' +
  'DEFAULTS TO THE CHEAPEST FORM — detail "minimal": one index line per node, only title / note / kind (标题 / 描述 / 类别), with workflow identity and scopeInfo; no config fields, no bodies, and no wire / mark / group / tree block. Ask for more only when the task needs it:\n' +
  '- "standard": + all per-kind config fields (provider / model / size / savePath / waitPath / timer / net / control / dev*, db_table rows, input_file files, task steps), body *lengths* (no body text) and the build references (kinds, imageSizes, defaultImageSize, markColors, devFuncColors 功能色卡, cam / view).\n' +
  '- "full": everything incl. body text (input_text.text, prompt, task, goal, jscode), rows, files, steps — ask explicitly, best with ids:[...] so only those nodes come back heavy.\n' +
  '- Narrow with ids / scope + scopeDepth / bodies / bodyLimit, or sections = whitelist of the heavy blocks (nodes, marks, wires, groups, taskTree, superTree, tagCatalog, workflows, selection). 只查连线用 sections:["nodes","wires"]（minimal 档也认，不必为接线读整图配置）。\n' +
  '- ports (standard / full): fixed-port nodes (proc_image / tts_gen / video_gen / remotion / judge / tool·function / super boundary) carry ports:[{dir,index,name,kind,connectedTo}] — read the wiring targets before connecting instead of reading a connect error.\n' +
  'scopeInfo is always returned（这次读的是整图还是某一颗壳内部）; every result carries a sizeHint with its own character cost.\n\n' +
  'When the run is locked to its own canvas（会话所属画布）, workflows lists ONLY that canvas — you cannot see or open others. 建图 / 连线 / 排版的完整硬规则（task 端点、super 边界端子、tool/function 参数即端子、@引用三条件、save 与 wait_file、批次与文生图）只写在技能 mtnode-canvas-edit-rules（按需加载），此处不重复。'

const APP_DESC = NODE_LOCK + `Control the MTNode desktop app beyond node graph edits (workflow status, rename, select nodes, undo/redo, delete with confirmation, DSH plugin install).

Available actions:
- status / list_workflows: inspect app + workflow catalog. When the run is locked to its own canvas（会话所属画布：agent_task nodes, agent session, assistant "current" scope）, the catalog contains ONLY that canvas — other workflows are omitted.
- rename_workflow: rename the canvas this run belongs to (or a specified workflow) — other canvases are rejected when locked
- select_nodes: select nodes by id/title (optional; empty clears selection). Selection highlight only — it acts on the canvas on screen, so it is rejected when this run's own canvas is in the background.
- undo / redo: undo or redo the last canvas edit — same foreground-only rule (the undo stack belongs to the canvas you see).
- list_dsh_plugins: list DSH agent plugins (id, package name, enabled/disabled, core/user). Does not restart the engine.

Needs user confirmation (UI will prompt; may be rejected):
- delete_workflow: permanently delete a workflow and its local assets (other canvases rejected when locked)
- install_dsh_plugin: install a DSH plugin (npm package name, GitHub URL, local path, or .tgz). Pass pkg. Engine restarts after install. Packages are stored under the app config data directory (survive app updates).
- remove_dsh_plugin: remove a user-installed DSH plugin. Pass pkg (package name). Bundled suites can only be unmounted via set_dsh_plugin.
- set_dsh_plugin: mount or unmount a non-core plugin. Pass pkg and enabled (boolean); optional id when multiple rows share a name.

For creating/editing/wiring/removing NODES or canvas drawings (marks) on the canvas this run belongs to（会话所属画布，不是用户此刻看到的这张）, use mtnode_canvas_edit instead (confirmed when called from the global assistant or the agent-session view; rejection stops the agent session).`

/* 工具描述只留「卡口」：kind 枚举、端子语义一句话、5 条不变量 + 一句指向技能。
   完整硬规则（task 三端、super 边界、tool/function 参数即端子、@引用三条件、
   save 与 wait_file、批次与文生图、数据库 / 开发节点 / 排版 / scope 细则）已迁到
   按需技能 mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md —— 工具描述每轮都随
   历史重发，长规则只有「建图 / 连线 / 批量 / 媒体」时才需要，命中再加载即可。 */
const EDIT_DESC = NODE_LOCK + `在当前画布上创建 / 修改 / 连线 / 删除 / 分组 / 自动排版节点，并用 createMarks / updateMarks / removeMarks 画装饰（text / box / arrow）。先 mtnode_canvas_get 读图，再在一次调用里建完整子图；alias 只在本调用内有效（connect / update / refs 用它）。返回是自足的改动回执：计数 + 每个 created / updated 的 x/y/w/h 与端口占用摘要 + warnings，不必再回读画布（detail:"diff" 只要明细）；确要复核别的节点或取正文再用 mtnode_canvas_get（ids:[...]）。

create.kind 枚举见 schema：输入 input_*（媒体输入由用户自己选文件）· 处理 proc_text / proc_image / agent_task / db_table · 生成 music_gen / tts_gen / video_gen / remotion · 保存 save · 批次 split / merge · 控制 control / judge / task · 节拍 wait_file / timer / delayer / sequencer / gate / splitter / counter / mutex · 容器与广播 super / db_replica / global / execute · 计算 tool / function。端子语义：tool / function 的参数表就是端子表（输入端子 0 = 控制入、1..N 各入参；输出 0..M-1 各出参、末位控制出）；judge 只有两个输出：fromIndex 0 = YES、1 = NO；super 对外只暴露边界端子，跨壳 / 跨层级用 superConnect。

端子预检：canvas_get（detail "standard" / "full"）对端子数固定的节点直接回 ports:[{dir,index,name,kind,connectedTo}]，接线前先看它；connect 失败时 warnings 会带候选端子清单与正确接法建议（如单数据端子已被占 → 用 super 汇聚或拆节点），save 的路径后缀按输入类型强制（.md / .yaml / .png / .wav / .mp4）并回 warning，不必等服务商报错。

不变量（违反即接线错）：
- 标题必须唯一。
- 智能节点（agent_task、agent:true 的 proc_text）自己会写文件：其后不接 save、也不当数据输入；用 wait_file 以控制线挡下游。
- proc_image 每次运行只出 1 张图（多图 = 1:1 批量项 / 多个 proc_image 节点 / attempts N）。
- batchMode "batch" 每条一次运行、每次只看该条：严禁把整批 N 条再灌进每次运行（≈N² 调用）；要一次看全部用 "agg"。
- 绝不删除或与正在运行本任务的节点重叠；改完告诉用户可编辑输入并用 control ▶ 重跑。

完整硬规则只写在技能 mtnode-canvas-edit-rules（save 与 wait_file、批次与文生图、task 三端、@引用三条件、数据库 / 开发节点 / 排版 / scope 细则都在那里）：建图 / 连线 / 批量 / 媒体前先用 skill 工具加载它。`

/* 绘制（mark）字段表：createMarks 用这份表；updateMarks 与旧别名 marks 只指回它，不重复序列化。
   around 的旧别名 nodes 仍被渲染层接受，但不再写进 schema。 */
const MARK_PROPS = {
  kind: { type: 'string', enum: ['text', 'box', 'arrow'], description: 'text 文字 · box 分区框 · arrow 箭头。' },
  label: { type: 'string', description: 'box 上方的标题（title 同义）。' },
  text: { type: 'string', description: 'text 标注正文。' },
  around: { type: 'array', items: { type: 'string' }, description: '框住哪些节点（id / alias / 标题）：排版后 box 贴合它们再加 pad。' },
  pad: { type: 'number', description: 'around 留白（默认 36）。' },
  x: { type: 'number' },
  y: { type: 'number' },
  w: { type: 'number' },
  h: { type: 'number' },
  x2: { type: 'number', description: 'arrow 终点 x。' },
  y2: { type: 'number', description: 'arrow 终点 y。' },
  color: { type: 'string', description: '#rrggbb（取 canvas_get 的 markColors）。' },
  fontSize: { type: 'number', description: '字号 10–48。' },
  stroke: { type: 'number', description: '线宽 1–8。' },
}

const MARK_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alias: { type: 'string', description: '本调用内局部名（updateMarks / removeMarks / group 引用）。' },
    ...MARK_PROPS,
  },
}

const MARK_UPDATE_SPEC = {
  type: 'object',
  additionalProperties: true,
  description: '改已有绘制：按 id | alias | 精确正文（title）定位，其余字段沿用 createMarks[] 那份表。',
  properties: {
    id: { type: 'string' },
    alias: { type: 'string' },
    title: { type: 'string', description: '按精确正文查找（须唯一）。' },
  },
}

/* 工具 / 函数节点的参数条目与工具定义（同一参数模型 [{name,kind,list}]）：
   参数即端子；list = 数组端子，可重复连数据线，JS 侧取到数组。 */
const PARAM_ENTRY_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '参数名 = 端子名；留空补「参数 N」。' },
    kind: { type: 'string', enum: ['text', 'image'], description: '端子类型（缺省 text；image 值 = 本机路径）：决定能否相接、着色与下游选型（图像输出 → 保存 .png）。' },
    list: { type: 'boolean', description: '数组端子：可重复连多条线，运行时值 = 按连线顺序的数组；未标 list 的端子连多条线只留一个值。' },
  },
}

const TOOL_CONFIG_SPEC = {
  type: 'object',
  additionalProperties: false,
  description: '工具节点（kind "tool" = super + tool:true 变体）的定义；参数即端子，端子数由参数钉死。',
  properties: {
    name: { type: 'string', description: '工具名（标题默认跟随它）。' },
    description: { type: 'string', description: '用途说明。' },
    inputs: { type: 'array', items: PARAM_ENTRY_SPEC, description: '输入端子表（传完整数组；增删参数即增删端子）。' },
    outputs: { type: 'array', items: PARAM_ENTRY_SPEC, description: '输出端子表（传完整数组；末位控制出不在表内）。' },
  },
}

/* 节点属性表：create 与 update 共用（同一份对象引用、每个字段的描述只写一遍）。
   旧「文本对话」节点的遗留字段 systemPrompt 已移除（该 kind 已不存在，渲染层不认）。
   各类型的长规范在助手系统提示与内置技能里，这里只留取值 / 端子口径；
   不言自明的数值项不再配描述（省负载）。 */
const NODE_PROPS = {
  title: { type: 'string', description: '唯一显示标题；@标题 引用它。' },
  tags: { type: 'array', items: { type: 'string' }, description: '节点标签，供 @标签名 引用。' },
  text: { type: 'string', description: 'input_text 正文。' },
  prompt: { type: 'string', description: 'proc_text / proc_image 提示词（也是 judge 判据）；可写 @标题 / @标签名。' },
  task: { type: 'string', description: 'agent_task 任务描述；可写 @标题 / @标签名。' },
  goal: { type: 'string', description: 'task：本步要达成什么。' },
  steps: { type: 'array', items: { type: 'string' }, description: 'task：有序子步骤标题。' },
  parentTaskId: { type: 'string', description: '放进某 task 内部（id / alias / 标题）；父 task 要先在同一次调用里建。' },
  parentSuperId: { type: 'string', description: '放进某 super 内部（id / alias / 标题）；需 canvas_super。' },
  scope: { type: 'string', description: '局部画布：本次调用只在这一颗超级 · 开发节点内部（id 或唯一标题；"global" = 整图）。界外节点跳过 + warnings。' },
  scopeDepth: { type: 'string', enum: ['direct', 'all'], description: '"direct" = 那颗壳 + 直接子节点（默认）· "all" = 整棵子树。' },  note: { type: 'string', description: 'super 卡片说明（开发节点必须【功能】+【实现】两段）。' },
  expandW: { type: 'number', description: 'super 展开态宽度。' },
  expandH: { type: 'number', description: 'super 展开态高度。' },
  subFolder: { type: 'string', description: 'super 下相对工作目录的子目录（内部节点相对路径默认落这里）。' },
  superOpen: { type: 'boolean' },
  db: { type: 'boolean', description: 'super 标为数据库节点（事实存 subFolder + 内部信息节点，编译后出 db_replica）。' },
  dbMode: { type: 'string', enum: ['super', 'db'], description: '数据库 super 形态：画布式 / 控制台。' },
  dev: { type: 'boolean', description: 'super 标为开发节点（见技能 mtnode-dev-architect）。' },
  devPath: { type: 'string', description: 'dev：项目根绝对路径（顶层块设，子块就近继承）。' },
  devStatus: { type: 'string', enum: ['pending', 'wip', 'done'] },
  devKind: { type: 'string', enum: ['module', 'file', 'class', 'interface', 'enum'], description: 'dev：module → file → 类图元素。' },
  devColor: { type: 'string', description: 'dev：外框色 #rrggbb；只用于改正功能色卡的自动上色，勿自创色值。' },
  devModel: { type: 'string', description: 'dev：本块 Agent 模型 id（建议 / 开发 / 细化都用它）；子块未自选则就近继承。' },
  devProvider: { type: 'string', description: 'dev：devModel 的路由（可省，按模型推断）。' },
  devPreset: { type: 'string', description: 'dev：预设档 = AGENT_PRESETS id（minimal / standard / lean / code / cordis）。' },
  devEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', ''], description: 'dev：思考强度档。' },
  devFiles: { type: 'array', items: { type: 'string' }, description: 'dev：核心文件（≤10 条 · 相对 devPath）；最外层项目块不要传。' },
  execPath: { type: 'string', description: 'execute：绑定文件绝对路径（.exe / .bat / .cmd / .lnk）；无数据端子。' },
  execIcon: { type: 'string', description: 'execute：图标 auto / rocket / gear / terminal / play / bolt / wrench / folder / file / power。' },
  execColor: { type: 'string' },
  savePath: { type: 'string', description: 'save 落盘路径；扩展名按输入类型强制 .yaml / .png / .wav / .mp4。' },
  waitPath: { type: 'string', description: 'wait_file：监视到该文件存在才放行下游。' },
  waitIntervalSec: { type: 'number', description: 'wait_file：轮询秒 1–60。' },
  timerMode: { type: 'string', enum: ['once', 'interval', 'cron'], description: 'timer：once → timerAt · interval → timerEverySec · cron → timerCron。' },
  timerAt: { type: 'string', description: 'timer once：本地时间 "YYYY-MM-DDTHH:mm"。' },
  timerEverySec: { type: 'number', description: 'timer interval：间隔秒 1–604800。' },
  timerCron: { type: 'string', description: '5 段 "min hour dom mon dow"。' },
  timerArmed: { type: 'boolean', description: 'timer：是否上膛。' },
  imagePath: { type: 'string', description: 'input_image：本机图片绝对路径（应用复制进画布资产）。' },
  imagePaths: { type: 'array', items: { type: 'string' }, description: 'input_image：多张图片路径（即批量项）。' },
  toolConfig: TOOL_CONFIG_SPEC,
  fnName: { type: 'string', description: '函数节点函数名。' },
  description: { type: 'string', description: '函数节点用途说明。' },
  jscode: { type: 'string', description: '函数节点 JS：input = { 参数名: 值 }（图像 = { kind:"image", path }），return { 输出参数名: 值 }。' },
  inputs: { type: 'array', items: PARAM_ENTRY_SPEC, description: '函数节点输入端子表（工具节点用 toolConfig.inputs）；改表即改端子。' },
  outputs: { type: 'array', items: PARAM_ENTRY_SPEC, description: '函数节点输出端子表（工具节点用 toolConfig.outputs）；末位控制出不在表内。' },
  agent: { type: 'boolean', description: 'proc_text：开启智能模式。' },
  bgRmOn: { type: 'boolean', description: 'proc_image 透明背景（抠图出带 Alpha 的 PNG）：内部先出纯黑基准、再以它为参考图复刻纯白并逐像素差分出 Alpha；约 2 倍 Token，仅支持把基准图当参考图下发的服务商才会抠图。false / 省略 = 正常单张出图。' },
  globalRefs: { type: 'boolean', description: '允许 @引用全局广播（还要在 prompt/task 写明 @标题）。' },
  auto: { type: 'boolean', description: 'save：上游运行即自动保存。' },
  batch: { type: 'boolean', description: 'input_*：开启批量项。' },
  batchMode: { type: 'string', enum: ['batch', 'agg'], description: '"batch" 每条一次运行（只看该条）；"agg" 一次看全部。' },
  providerId: { type: 'string', description: 'proc_text / proc_image：API 服务商 id 或名称。' },
  provider: { type: 'string', description: '智能节点路由：deepseek-official / mtnode_<id> / 服务商名。' },
  model: { type: 'string', description: '本节点模型 id（运行中的别改）。' },
  size: { type: 'string', description: 'proc_image 尺寸，须是 canvas_get 的 imageSizes 之一（如 "2048x1360" / "auto"）。' },
  imgQuality: { type: 'string', enum: ['', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'proc_image 的 quality 直传参数：low/medium/high/xhigh/max；空 = 不传（服务商按 auto）；旧版 DALL·E 的 standard / hd 不要传。' },
  imgBackground: { type: 'string', enum: ['', 'auto', 'opaque', 'transparent'], description: 'proc_image 的 background 直传参数：transparent 直出带 Alpha 的 PNG（自动补「背景透明」提示词并禁用差分抠图 bgRmOn）；opaque；空 = 不传。' },
  maskOn: { type: 'boolean', description: 'proc_image 蒙版局部重绘（透明区 = 重绘，只对第 1 张 image 生效）：maskPath 须由用户在节点头部蒙版编辑器涂抹（Agent 不能代画）；需图像输入 + OpenAI 兼容图像服务商；与 ratioLockOn 同时开以蒙版为准；带蒙版时请求的 size 钉成首张参考图的像素尺寸，节点自己选的 size 这一轮不生效。' },
  remotionSize: { type: 'string', description: 'remotion 分辨率（宽x高）。' },
  fps: { type: 'number', description: 'remotion 帧率 1–60。' },
  attempts: { type: 'number', description: '抽卡次数 1–10（生成类节点）。' },
  outputPath: { type: 'string', description: 'video_gen / music_gen / tts_gen 输出路径（.mp4 / .wav / .mp3）。' },
  voice: { type: 'string', description: 'tts_gen 音色（留空 = 默认，勿编造）。' },
  speed: { type: 'number', description: 'tts_gen 语速 0.5–2.0。' },
  videoMode: { type: 'string', enum: ['r2v', 'fl2va'], description: 'video_gen：fl2va 首末帧（默认）/ r2v 多参考（端子：1 提示词 · 2–10 参考图 I1–I9 · 11–13 参考视频 V1–V3 · 14–16 参考音频 A1–A3）。' },
  duration: { type: 'number', description: '时长秒：video_gen 4–15，remotion 1–60。' },
  outputRes: { type: 'string', enum: ['auto', '480p', '720p', '1080p'] },
  postEnabled: { type: 'boolean', description: 'video_gen 超分补帧后处理（24G 建议关）。' },
  postInterp: { type: 'boolean', description: 'video_gen RIFE 补帧开关。' },
  workflowId: { type: 'string', description: 'video_gen 自建 ComfyUI 工作流库 id（H3 窗口导入，勿编造）；非空时端子按该工作流参数重排。' },
  ctrlAction: { type: 'string', enum: ['run', 'clear'], description: 'control 动作：只建 run，不要建 clear。' },
  ctrlRole: { type: 'string', enum: ['start', 'endSuccess', 'endFail'], description: 'control 角色（task 自带三端勿删）。' },
  refs: { type: 'array', items: { type: 'string' }, description: '要补进 prompt/task 的 @标题 / @标签名。' },
  delaySec: { type: 'number', description: 'delayer：延时秒。' },
  seqOutputs: { type: 'number', description: 'sequencer：顺序输出数 2–8。' },
  seqGapSec: { type: 'number', description: 'sequencer：输出间隔秒。' },
  gateInputs: { type: 'number', description: 'gate：AND 输入数 2–8。' },
  splitOutputs: { type: 'number', description: 'splitter：并行输出数 2–8。' },
  counterEvery: { type: 'number', description: 'counter：每 N 次触发放行 2–99。' },
  counterCount: { type: 'number' },
  mutexInputs: { type: 'number', description: 'mutex：输入数 2–8。' },
  mutexMode: { type: 'string', enum: ['first', 'priority', 'random'], description: 'mutex：哪个输入胜出。' },
  netChannel: { type: 'number', description: 'net_recv / net_send：通道号 0–65535。' },
  netProto: { type: 'string', enum: ['tcp', 'udp'] },
  netHost: { type: 'string', description: 'net_recv / net_send：地址。' },
  netPort: { type: 'number', description: 'net_recv / net_send：端口（0 = 全局设置）。' },
  netAutoListen: { type: 'boolean', description: 'net_recv：启动即监听。' },
  dbNodeId: { type: 'string', description: 'db_replica：镜像的数据库 super id。' },
  dbName: { type: 'string', description: 'db_replica：源数据库显示名。' },
  ctrlPinned: { type: 'boolean' },
  ctrlFillOnly: { type: 'boolean', description: 'control run：只填数据不触发运行。' },
  x: { type: 'number' },
  y: { type: 'number' },
}

const NODE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alias: { type: 'string', required: true, description: '本调用内局部名（必填）。' },
    kind: { type: 'string', required: true, enum: KINDS, description: '节点类型（必填）；图像参考节点用 input_image。' },
    ...NODE_PROPS,
  },
}

/* update 与 create 共用上面那份属性表：这里不再整表重复一遍（那会在工具 JSON 里
   序列化两次），只显式列定位与尺寸键，其余字段语义指向 create[]。
   渲染层 applyNodePatch 只认属性表内的字段（kind 建好即不可改）。 */
const UPDATE_SPEC = {
  type: 'object',
  additionalProperties: true,
  description: '可改字段与 create[] 的属性表同一份（省略的键保持原样，数组整体替换；kind 不可改）。',
  properties: {
    id: { type: 'string', description: '目标节点 id（最稳）。' },
    alias: { type: 'string', description: '本次 create[] 的 alias。' },
    title: { type: 'string', description: '按现有标题查找（须唯一）。' },
    setTitle: { type: 'string', description: '改标题（自动去重）。' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
}

const PAIR_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true, description: '源节点：id / alias / 唯一标题。' },
    to: { type: 'string', required: true, description: '目标节点：id / alias / 唯一标题。' },
    fromIndex: { type: 'number', description: '源的输出端子序号（默认 0）；judge 0 = YES、1 = NO；tool / function 按参数表数端子。' },
    rel: { type: 'boolean', description: '关系线：UML 直线，不传数据也不参与执行（忽略 fromIndex）。' },
    relLabel: { type: 'string', description: '关系线文字（如 调用 / 依赖）。' },
    relArrow: { type: 'string', enum: ['forward', 'backward', 'both', 'none'] },
  },
}

function jsonResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/* 返回体积收紧：canvas_get 默认档位从 standard 再降到 minimal —— 缺省只回「节点索引」：
   每节点只有 标题 / 描述(note) / 类别(kind)，重型块只留 nodes（marks / wires / groups /
   taskTree / superTree / tagCatalog / workflows / selection 一概不带），静态词表与视角
   （kinds / imageSizes / markColors / devFuncColors / cam / view）也不带。要配置字段显式传
   detail:"standard"（配置齐全 + 正文只给 *Len + 建图参考表），要看全文再显式 detail:"full"
   （配合 ids / sections 收窄）。默认给索引，等于一次读图不再把整图配置灌进长期历史。 */
const DEFAULT_GET_DETAIL = 'minimal'

/* 在返回体里带一句体积提示：让模型知道这次读了多少字符、怎么读更省。 */
function withGetHint(value, detail) {
  if (!value || typeof value !== 'object') return value
  const chars = JSON.stringify(value).length
  const nodes = Array.isArray(value.nodes) ? value.nodes.length : 0
  return Object.assign({}, value, {
    sizeHint:
      '本次返回 ' + chars + ' 字符 / ' + nodes + ' 个节点（detail=' + detail +
      '，默认 minimal 是纯节点索引：每节点只给 标题 / 描述 / 类别，配置、正文与连线 / 绘制 / 分组 / 树一律不给；要配置用 detail:"standard"，要全文用 detail:"full" + ids:[...] 收窄，' +
      '只用连线用 sections:["nodes","wires"]）。',
  })
}

function clipLabel(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return str.length > n ? str.slice(0, n) + '…' : str
}

/* 回执自足：每条 created / updated 带上位置、尺寸与端口占用摘要（端子 index/name/kind/已连数），
   模型改完不必再 canvas_get 回读才知道长什么样、哪个端子空着。 */
function editNodeReceipt(n, withAlias) {
  if (!n || typeof n !== 'object') return n
  const ref =
    (withAlias && n.alias ? n.alias + '=' : '') +
    clipLabel(n.title || n.id || '', 60) + '(' + clipLabel(n.kind || '', 24) + ')'
  return {
    ref,
    id: n.id,
    title: clipLabel(n.title || '', 60),
    kind: n.kind,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    ports: n.ports,
  }
}

/* canvas_edit 成功时渲染层会回一整份 canvasSnapshot（含全部节点正文），历史里最占体积。
   这里只留「改动回执」，需要看画布再走 mtnode_canvas_get。
   detail:"diff" = 只回本次 created/updated/connected/removed 明细，不回计数摘要与提示。 */
function editSummary(value, detail) {
  if (!value || typeof value !== 'object') return value
  const list = (v) => (Array.isArray(v) ? v : [])
  const created = list(value.created)
  const updated = list(value.updated)
  const connected = list(value.connected)
  const removed = list(value.removed)
  const createdMarks = list(value.createdMarks)
  const updatedMarks = list(value.updatedMarks)
  const removedMarks = list(value.removedMarks)
  const createdReceipt = created.map((n) => editNodeReceipt(n, true))
  const updatedReceipt = updated.map((n) => editNodeReceipt(n, false))
  const connectedReceipt = connected.map((w) => clipLabel((w && (w.fromTitle || w.from)) || '', 60) + '→' + clipLabel((w && (w.toTitle || w.to)) || '', 60))
  const removedReceipt = removed.map((id) => clipLabel(id, 60))
  if (detail === 'diff') {
    return {
      ok: value.ok !== false,
      created: createdReceipt,
      updated: updatedReceipt,
      connected: connectedReceipt,
      removed: removedReceipt,
      warnings: list(value.warnings),
    }
  }
  const out = {
    ok: value.ok !== false,
    counts: {
      created: created.length,
      updated: updated.length,
      connected: connected.length,
      removed: removed.length,
      marksCreated: createdMarks.length,
      marksUpdated: updatedMarks.length,
      marksRemoved: removedMarks.length,
      grouped: value.grouped ? 1 : 0,
    },
    /* alias 只在本调用内有效，下一轮定位靠标题 / id，故两个都给出 */
    created: createdReceipt,
    updated: updatedReceipt,
    connected: connectedReceipt,
    removed: removedReceipt,
    marks: createdMarks.concat(updatedMarks).map((m) =>
      (m && m.alias ? m.alias + '=' : '') + clipLabel((m && m.kind) || 'mark', 12) +
      (m && m.text ? ':' + clipLabel(m.text, 40) : '')),
    removedMarks: removedMarks.map((id) => clipLabel(id, 60)),
    warnings: list(value.warnings),
    hint: '整图快照已省略（回执已含位置 / 尺寸与端口占用，无需回读）；确要复核别的节点用 mtnode_canvas_get（detail:"minimal" 或 ids:[...]）。',
  }
  if (value.message) out.message = clipLabel(value.message, 80)
  if (value.grouped) out.grouped = clipLabel(value.grouped.title || value.grouped.id || '', 60)
  return out
}

export function apply(ctx) {
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()
  /* canvas_get 内容哈希缓存：哈希（渲染层给的结构哈希）+ 本次请求参数 都相同 = 同一份
     结果已经进过历史，直接回「无变化」短回执，不再重发整图。首读照常回全量。 */
  const getSeen = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone */ }
    }
  }

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(err)
    }
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'canvas-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'canvas op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('canvas op aborted (task ended)'))
    }
  }

  const connect = () => {
    if (!Number.isInteger(port) || port <= 0) return
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      failAll(new Error('canvas channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  /* 注册口（本文件里唯一的裁剪判定点）：三个闸都在 spawn 时定死，整台运行时一个形状。
     · env MTNODE_LEAN_TOOLS（设置里的「精简工具负载」）→ 不注册「可选能力」工具
       mtnode_app / mtnode_vision（集合见 LEAN_DROP_WHEN_LEAN）；
     · env MTNODE_NO_CANVAS（画布智能节点 nodeLock 运行）→ 不注册画布主干
       mtnode_canvas_get / mtnode_canvas_edit / mtnode_app（集合见 NODE_LOCK_DROP_CANVAS），
       宿主对这三类帧本来就一律拒收；mtnode_vision 保留 —— 智能节点被允许用它识图。
     · env MTNODE_HIDE_TOOLS（按运行算出的规范名单，真源 tool-visibility.mjs）→ 点名的
       工具整个不注册。走这条的是「Agent 工具许可」预设里被拒到点上的画布 / 应用 / 识图
       工具：宿主侧本来就硬拦，定义照发只换来模型一次次撞没有的工具。
     两个标记与这份名单都进 runtime key（gateway.mjs 的 lean: / nc: / hx:），换档即冷起
     自己的运行时，绝不会出现「同一台运行时两种可见集」互相打爆提示缓存。网关同时在预设
     文本后补一句「这些工具不存在」，模型不会去撞没有的工具（见 LEAN_TOOLS_NOTE）。 */
  const lean = leanToolsOn()
  const noCanvas = noCanvasToolsOn()
  const hidden = hiddenToolsFromEnv()
  const register = (tool) => {
    const toolName = tool && tool.name
    if (lean && LEAN_DROP_WHEN_LEAN.has(toolName)) return
    if (noCanvas && NODE_LOCK_DROP_CANVAS.has(toolName)) return
    if (hidden.has(toolName)) return
    ctx.tools.register(tool)
  }
  const rpc = (op, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('canvas channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    /* 发起轮盖章:agent.id 就是该 agent 所在 session 的 id(dsh 里 Agent.id: SessionId,
       根 agent 由 restoreOrCreateConfigured → create(sessionId,…) 用 session id 建),
       与 bridge-plugin 的 question 帧取法一致。网关据此判归属;取不到 agent 就发空串,
       由网关 fail closed 直接 abort —— 归属不明的画布确认框绝不该弹给用户。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'canvas', id, sessionId, op, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('canvas op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  register(defineTool({
    name: 'mtnode_canvas_get',
    description: GET_DESC,
    parameters: {
      detail: {
        type: 'string',
        enum: ['minimal', 'standard', 'full'],
        description:
          'Node field granularity. DEFAULT (when omitted) = "minimal": per node only title / note / kind (标题 / 描述 / 类别) — no id, no position, no status, no config fields, no bodies, and no heavy block (marks / wires / groups / trees) either. standard = minimal + all per-kind config fields (provider/model/size/paths/timer/net/control/…, db_table rows, input_file files, task steps) + body *lengths* only, no body text, and the build references (kinds, imageSizes, defaultImageSize, markColors, devFuncColors, cam/view). full = everything incl. full text bodies (input_text.text, prompt, task, goal, jscode), rows, files, steps — you must ask for it explicitly, ideally with ids:[...] so only the nodes you need come back heavy.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Return ONLY these nodes (match by node id or unique title). Wires are restricted to the selected nodes. Use with detail:"full" to fetch a single node\'s complete config cheaply.',
      },
      scope: {
        type: 'string',
        description:
          'Read ONLY the inside of this super / dev / db node (id or unique title). "global" = whole canvas. Inspect one shell without pulling the whole graph into context.',
      },
      scopeDepth: {
        type: 'string',
        enum: ['direct', 'all'],
        description:
          'With scope: "direct" = that shell plus its direct children (default) · "all" = the whole subtree underneath it.',
      },
      bodies: {
        type: 'boolean',
        description:
          'Include full body text (text/prompt/task/goal). Default: true when detail="full", false otherwise. When false, *Len counts are still returned.',
      },
      bodyLimit: {
        type: 'number',
        description:
          'Truncate each body value to N characters (0 = no limit, default). *Len fields always report the true length.',
      },
      sections: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Whitelist of the heavy top-level blocks: nodes, marks, wires, groups, taskTree, superTree, tagCatalog, workflows, selection. At detail "minimal" ONLY nodes is returned unless you name others here（只查连线就用 ["nodes","wires"]）; at "standard" / "full" the default is all of them and this list narrows it. The small envelope (workflow, scopeInfo, assistScope / scopeNote) is always included.',
      },
    },
    timeoutMs: 15000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      const a = Object.assign({}, args || {})
      if (a.detail !== 'minimal' && a.detail !== 'standard' && a.detail !== 'full') {
        a.detail = DEFAULT_GET_DETAIL
      }
      const value = await rpc('get', a, exec)
      const hash = value && typeof value.contentHash === 'string' ? value.contentHash : ''
      if (hash) {
        const key = hash + '|' + JSON.stringify(a)
        if (getSeen.has(key)) {
          return jsonResult({
            ok: true,
            unchanged: true,
            contentHash: hash,
            sizeHint: '画布结构自上次读取以来无变化，本次 0 个节点重发（约 90 字符，同一份结果已在本会话历史里）。要节点正文用 ids:[...] + detail:"full"。',
          })
        }
        if (getSeen.size > 200) getSeen.clear()
        getSeen.set(key, true)
      }
      return withGetHint(value, a.detail)
    },
  }))

  register(defineTool({
    name: 'mtnode_app',
    description: APP_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'status',
          'list_workflows',
          'rename_workflow',
          'delete_workflow',
          'select_nodes',
          'undo',
          'redo',
          'list_dsh_plugins',
          'install_dsh_plugin',
          'remove_dsh_plugin',
          'set_dsh_plugin',
        ],
        description: 'App-level action to perform.',
      },
      node: {
        type: 'string',
        description: 'For select_nodes: node id or unique title.',
      },
      nodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'For select_nodes: multiple ids or unique titles.',
      },
      workflow: {
        type: 'string',
        description:
          'For rename/delete: workflow id or exact name — when the run is locked to its own canvas（会话所属画布）, that canvas is the only valid target.',
      },
      name: {
        type: 'string',
        description: 'For rename_workflow: display name.',
      },
      pkg: {
        type: 'string',
        description:
          'For install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin: npm package, GitHub URL, local path, .tgz, or installed package name.',
      },
      plugin: {
        type: 'string',
        description: 'Alias of pkg for DSH plugin actions.',
      },
      enabled: {
        type: 'boolean',
        description: 'For set_dsh_plugin: true = mount, false = unmount.',
      },
      id: {
        type: 'string',
        description: 'For set_dsh_plugin: optional cordis row id when disambiguating.',
      },
    },
    timeoutMs: 600000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      return rpc('app', args || {}, exec)
    },
  }))

  register(defineTool({
    name: 'mtnode_canvas_edit',
    description: EDIT_DESC,
    parameters: {
      create: {
        type: 'array',
        description: '要新增的节点；alias 必填，本次调用内的 connect / update / refs 用它引用这个新节点。',
        items: NODE_SPEC,
      },
      update: {
        type: 'array',
        description: '补丁已有或本次新建的节点：按 id / alias / 唯一标题定位，可改字段与 create[] 同一份属性表（kind 不可改）。',
        items: UPDATE_SPEC,
      },
      connect: {
        type: 'array',
        description: '连线：源 → 目标。表达关系的 UML 直线（不传数据、不参与执行）用 rel:true + relLabel / relArrow。',
        items: PAIR_SPEC,
      },
      disconnect: {
        type: 'array',
        description: '删除匹配 from→to 的连线；字段与 connect[] 同一份表（from / to / fromIndex，断关系线带 rel:true）。',
        items: { type: 'object', additionalProperties: true },
      },
      superConnect: {
        type: 'array',
        description:
          '跨 super / 跨层级连通两个节点：[{from,to}]（字段同 connect[]）。自动逐层桥接边界端子，无需手建桥接线；需 canvas_super。',
        items: { type: 'object', additionalProperties: true },
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: '要删除的节点 id / alias / 唯一标题；正在运行本任务的节点删不掉。',
      },
      group: {
        type: 'object',
        additionalProperties: false,
        description: '把节点与绘制打包成组（整组一起移动 / 缩放）；分区框建议一并放进来。',
        properties: {
          title: { type: 'string', description: '组名，如 处理区。' },
          nodes: { type: 'array', items: { type: 'string' }, description: '要包含的节点 / 绘制 id、alias 或标题；省略 = 本次 create[] 的全部节点。' },
          marks: { type: 'array', items: { type: 'string' }, description: '要包含的绘制 id / alias / 精确正文。' },
        },
      },
      createMarks: {
        type: 'array',
        description: '画布绘制（text / box / arrow）；优先 box + around:[alias] + label 划分区，在节点自动排版之后贴合生成。',
        items: MARK_SPEC,
      },
      marks: {
        type: 'array',
        description: 'createMarks 的旧别名，字段完全相同。',
        items: { type: 'object', additionalProperties: true },
      },
      updateMarks: {
        type: 'array',
        description: '改已有绘制（按 id / createMarks 的 alias / 精确正文定位）。',
        items: MARK_UPDATE_SPEC,
      },
      removeMarks: {
        type: 'array',
        items: { type: 'string' },
        description: '要删除的绘制 id / alias / 精确正文。',
      },
      layout: {
        type: 'boolean',
        description: '自动排版（分层左到右、互不重叠）：create 非空时默认 true，只有你自己给了 x/y 时才传 false。',
      },
      setWorkflowName: {
        type: 'string',
        description: '改当前画布标签名（可选）。',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'diff'],
        description:
          '回执口径：summary（默认）= 计数摘要 + created/updated 明细（含 x/y/w/h 与端口占用）；diff = 只回本次 created/updated/connected/removed 明细，不回计数摘要。回执已自足，无需回读画布。',
      },
    },
    timeoutMs: 300000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      const a = args || {}
      return editSummary(await rpc('edit', a, exec), a.detail)
    },
  }))

  const VISION_DESC = `Vision subagent: inspect a local image with a multimodal (vision) model and return a text answer. Use when you need to READ pixels mid-task — e.g. game UI layout, screenshot OCR, icon/button recognition, verifying a generated image — without wiring a permanent vision node.

Requirements:
- imagePath must be an absolute path on THIS machine (workflow asset path, screenshot file, etc.).
- question: what to look for (Chinese OK). Be specific.
- FIRST CALL in this app requires user permission (host shows Allow once / Always allow / Deny), unless the user already set Always allow / full-access / session allow in the top-right Approvals button.
- The host picks a vision model by provider order then model order in Settings → Model services (DeepSeek text models cannot read images; use deepseek-v4-flash-vision-exp or another vision-capable OpenAI-compatible provider).
- Prefer this over attaching large image batches to the main agent prompt (saves tokens; avoids N² batch mistakes).
- Do not use for generating new images — only for understanding existing ones.`

  register(defineTool({
    name: 'mtnode_vision',
    description: VISION_DESC,
    parameters: {
      imagePath: {
        type: 'string',
        required: true,
        description: 'Absolute path to a local image file to inspect.',
      },
      question: {
        type: 'string',
        required: true,
        description:
          'What to look for / ask about the image (e.g. describe the game HUD and list clickable buttons).',
      },
      model: {
        type: 'string',
        description: 'Optional vision model id; omit to use the host default vision route.',
      },
    },
    timeoutMs: 180000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      return rpc('vision', args || {}, exec)
    },
  }))
}
