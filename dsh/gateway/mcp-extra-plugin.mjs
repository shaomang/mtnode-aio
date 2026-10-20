// MTNode 自用工具面（媒体生成 / 节点运行 / 用户工具 / 会话）—— **只做契约真源，不进网关**。
//
// 为什么不在 cordis.yml 里：这四个工具是 MTNode **自己**经 MCP 回环调自己的口（见
// guides/mcp-server.md 的「自用回环」）。它们既不该出现在 agent 的工具清单里（画布内的
// agent 已有 run/工具/媒体节点这些原生能力），也不该由网关执行 —— 执行方是 MTNode 主进程
// （媒体生成）与渲染层（跑节点、跑用户工具、会话）。
//
// 那为什么放在 dsh/gateway/ 里：scripts/build-mcp-contract.mjs 的工具契约真源就是这一层的
// defineTool 参数表。放这里，参数表只有一份，mcp-tools.json / mcp-tool-schemas.js 照旧生成，
// 不手抄第二份 schema。本文件只被那个脚本 import（真跑 register 抓规格），运行时无人加载。

const GENERATE_DESC =
  'Generate media with MTNode itself (image / music / speech / video) — the same backends the canvas nodes use, with the same global audio-video mutex.\n' +
  '- 结果异步：run 立刻回 jobId（wait:true 则等到完成再回）。产物是**本机绝对路径**，并已进 MTNode 素材库。\n' +
  '- 只有显式给 canvas + baseHash 才会额外在画布上建一个节点（createNode 默认 false）。\n' +
  '- action:"status" 查作业（jobId）；action:"list" 列本次运行的全部作业；action:"cancel" 取消（音乐 / 视频有真取消口，图像 / 语音只能等它跑完）。\n' +
  '- 作业只活在这次进程里：MTNode 重启后未完成的作业回「作业已丢失」。'

const RUN_DESC =
  'Run a node or a whole graph inside MTNode, asynchronously.\n' +
  '- action:"node"：跑**一个**节点（媒体节点 / 智能任务 / 处理节点），必须给 canvas + baseHash（写前版本校验，与 canvas_edit 同一口径）。\n' +
  '- action:"graph"：从控制节点起跑一整张图（等价于点那颗控制节点的 ▶），**不要** baseHash。\n' +
  '- 立刻回 jobId；action:"status" 查进度与结果（节点输出 / 错误 / 产物绝对路径）。\n' +
  '- 长任务（视频 / 音乐）会排队等全局音视频锁；作业只活在这次进程里。'

const TOOLS_DESC =
  'Use the tools the user built in MTNode (tool nodes on the canvas + tool-library entries marked always-on).\n' +
  '- action:"list"：列可调用的用户工具（名称 / 说明 / 入参表）。\n' +
  '- action:"call"：按名称调用一次，args 用入参名（也认 arg1..argN），回各输出端子的值。\n' +
  '- 默认全部放行（与内置工具同级）；关掉「自用回环」总开关后，这一族与其它三项一起消失。'

const SESSION_DESC =
  'Talk to an MTNode agent session (create / send / read / close) without touching the sessions the user is using.\n' +
  '- action:"create"：新建一条会话（左栏可见，标题标「外部调用」），默认**用完即弃**；给 keep:true 才保留。\n' +
  '- action:"send"：发一条消息并（默认 wait:true）等到这一轮结束，回助手最后一段回复；用完即弃的会话在这一轮后自动删除。\n' +
  '- action:"read"：读这条会话最近的消息；action:"close"：立刻删掉（keep 的会话不删，回一句说明）。\n' +
  '- 不读、不改用户自己的会话。'

export const name = 'mtnode-mcp-extra'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'mtnode_generate',
      description: GENERATE_DESC,
      parameters: {
        action: {
          type: 'string',
          enum: ['run', 'status', 'list', 'cancel'],
          description: 'run（默认）= 起一个作业；status = 查作业；list = 列作业；cancel = 取消。',
        },
        kind: {
          type: 'string',
          enum: ['image', 'music', 'speech', 'video'],
          description: 'run：生成哪一类。image = 文生图 / 图生图；speech = 语音（Breeze）；music = 音乐（MiniMax Music 3）；video = 视频（H3）。',
        },
        prompt: { type: 'string', description: 'image / music / video 的提示词（music 用它写曲风与演唱）。' },
        lyrics: { type: 'string', description: 'music：歌词正文（带结构标签，如 [Verse] / [Chorus]）。' },
        text: { type: 'string', description: 'speech：要念的台词正文（可用 [笑] 这类发声事件）。' },
        voice: { type: 'string', description: 'speech：音色（音色库 id 或名称；留空 = 用预设 / 参考音频）。' },
        presetId: { type: 'string', description: 'speech：预设音色 id。' },
        instruction: { type: 'string', description: 'speech：语气 / 表演指令（一句话风格描述）。' },
        refAudio: { type: 'string', description: 'speech：参考音频的**本机绝对路径**（音色克隆）。' },
        refText: { type: 'string', description: 'speech：参考音频对应的文本。' },
        model: { type: 'string', description: 'image：图像模型 id（留空 = 用本机已配的默认图像后端）。' },
        size: { type: 'string', description: 'image：尺寸，如 "1024x1024"（留空 = 后端默认）。' },
        refImage: { type: 'string', description: 'image：参考图的本机绝对路径（图生图）。' },
        duration: { type: 'number', description: 'video：时长秒（4-15）；music：目标时长秒。' },
        outputRes: { type: 'string', enum: ['auto', '480p', '720p', '1080p'], description: 'video：输出分辨率档位。' },
        seed: { type: 'number', description: '可复现随机种子（image / music / video）。' },
        outputPath: { type: 'string', description: '自定义产物路径（本机绝对路径）；留空 = 落 MTNode 托管目录。' },
        canvas: { type: 'string', description: '画布 id 或名称：给了才可能建节点，并决定产物落哪张画布的资产目录。' },
        baseHash: { type: 'string', description: 'createNode:true 时必填：先 canvas_get 拿到的 contentHash（版本校验）。' },
        createNode: { type: 'boolean', description: '在画布上额外建一个节点（需 canvas + baseHash；默认 false）。' },
        jobId: { type: 'string', description: 'status / cancel：作业 id。' },
        wait: { type: 'boolean', description: 'run：true = 等到作业结束再回（最长 15 分钟）；默认 false 立刻回 jobId。' },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('mtnode_generate 由 MTNode 主进程执行（mcp-media-agent.js），不在网关里跑');
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mtnode_run',
      description: RUN_DESC,
      parameters: {
        action: {
          type: 'string',
          enum: ['node', 'graph', 'status', 'list'],
          description: 'node（默认）= 跑一个节点；graph = 从控制节点起跑整图；status = 查作业；list = 列作业。',
        },
        nodeId: { type: 'string', description: 'node：节点 id（与 nodeTitle 二选一）。' },
        nodeTitle: { type: 'string', description: 'node：节点标题（须唯一）。' },
        canvas: { type: 'string', description: '画布 id 或名称（node 必填；graph 留空 = 当前画布）。' },
        baseHash: { type: 'string', description: 'node 必填：canvas_get 拿到的 contentHash。graph 不要给。' },
        controlNodeId: { type: 'string', description: 'graph：指定从哪颗控制节点起跑（留空 = 画布上第一颗 ctrlAction=run 的控制节点）。' },
        jobId: { type: 'string', description: 'status：作业 id。' },
        wait: { type: 'boolean', description: 'node / graph：true = 等到跑完再回（最长 15 分钟）；默认 false 立刻回 jobId。' },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('mtnode_run 由 MTNode 渲染层执行（renderer/mcp-extra.js），不在网关里跑');
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mtnode_tools',
      description: TOOLS_DESC,
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'call'], description: 'list = 列用户工具；call = 调一个。' },
        name: { type: 'string', description: 'call：工具名（action:"list" 回的名字，或它的 key）。' },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'call：入参对象，键 = 工具的入参名（也认 arg1..argN）；图像参数给本机绝对路径。',
        },
        canvas: { type: 'string', description: '在哪张画布上找工具节点（留空 = 当前画布）。' },
        detail: { type: 'string', enum: ['brief', 'full'], description: 'list：brief（默认，名称与说明）/ full（带完整入参表）。' },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('mtnode_tools 由 MTNode 渲染层执行（renderer/mcp-extra.js），不在网关里跑');
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mtnode_session',
      description: SESSION_DESC,
      parameters: {
        action: {
          type: 'string',
          enum: ['create', 'send', 'read', 'close'],
          description: 'create（默认）= 新建；send = 发一条并等回复；read = 读最近消息；close = 删除。',
        },
        sessionId: { type: 'string', description: 'send / read / close：会话 id（as…）。send 留空 = 新建一条再发。' },
        text: { type: 'string', description: 'send：消息正文。' },
        title: { type: 'string', description: 'create / send：会话标题（留空 = 「外部调用 · 首句」）。' },
        provider: { type: 'string', description: 'create / send：供应商（route 或名称；留空 = 默认）。' },
        model: { type: 'string', description: 'create / send：模型 id（留空 = 默认）。' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'create / send：思考档（留空 = high）。' },
        keep: { type: 'boolean', description: 'create / send：true = 这条会话留在左栏（默认用完即弃）。' },
        wait: { type: 'boolean', description: 'send：true（默认）= 等到这一轮结束并回助手回复。' },
        limit: { type: 'number', description: 'read：最多回多少条消息（默认 20，上限 200）。' },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('mtnode_session 由 MTNode 渲染层执行（renderer/mcp-extra.js），不在网关里跑');
      },
    }),
  )
}
