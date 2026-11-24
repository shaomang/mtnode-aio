/**
 * 按运行裁剪可见工具集 —— 网关与运行时插件共用的唯一真源。
 *
 * 每一次模型调用都把「全部可见工具的定义」重发一遍（优化前实测固定前缀 tools ≈ 98K 字符、
 * 空会话首步 32K token，且每一步都付）。所以「这一轮根本不可能用的工具」应该整个不发：
 *  · 我们自己注册的工具（画布 / 应用 / 识图 / 数据库）→ 在插件的注册口直接不注册；
 *  · dsh 引擎自带的工具（目标 / 任务清单 / 子代理 / 后台任务 / 提问）→ 注册在引擎包里，
 *    改不动注册，就用 ctx.tools.restrict({ deny }) 在 agent 作用域把它们从可见集摘掉
 *    （dsh-tools 明确：被 restrict 隐藏的工具整份 schema 不再进请求）。
 * 纯净模式走的是同一条口子的反向用法：restrict({ allow: PURE_KEEP_TOOLS })，除白名单
 * 之外一个都不发（见 PURE_TOOLS_ENV）。
 * 两条路共用同一份名单：gateway 按 run 参数算出规范名单 → spawn env MTNODE_HIDE_TOOLS
 * → 注册口 + mtnode-tool-visibility 插件各自读取。
 *
 * 缓存纪律（比省字符更重要）：可见集一旦在轮内变化，提示缓存从第一个变化的 schema
 * 起整段失效 —— 省了几千字符却赔掉整轮缓存。所以名单只在 **spawn 时**定档，并且
 * 进 runtime key（见 gateway.mjs 的 hx: 指纹）：换档 = 冷起一台自己的运行时，
 * 同档会话每一步的前缀完全一致。
 *
 * 纯模块：零 import、不读文件、不起进程，网关进程与运行时进程都能 import。
 */

/** spawn env 名：本台运行时不发给模型的工具清单（逗号分隔，规范排序）。 */
export const HIDE_ENV = 'MTNODE_HIDE_TOOLS'

/**
 * spawn env 名：本台运行时跑「纯净模式」的工具白名单档（'1' = 开）。
 * 与 HIDE_ENV 是两条腿：HIDE 只能点名摘除（可枚举的名字有限），纯净模式要的是
 * 「除白名单外一个都不发」—— 用 restrict({ allow }) 反向保留（见
 * plugins/tool-restrict-plugin.mjs），内置工具与 MTNode 自有工具一并生效。
 *
 * 为什么纯净模式要动工具：实测纯净轮的**系统提示已经是 0 token**，但工具定义
 * 每次请求都整份重发 —— 23,739 token，比普通轮（16,430）还多 7.3K（纯净轮把
 * lean / 按需裁一并关掉了）。剩下的 3.6K 才是用户原话。所以「纯净模式仍有大量
 * token」的根子在工具 schema，不在提示词。
 */
export const PURE_TOOLS_ENV = 'MTNODE_PURE_TOOLS'

/**
 * 纯净模式保留的工具（用户口径：读 / 写 / 命令 / 联网搜索）。
 *
 * 名字必须只含 [a-z0-9_]（env 与 restrict 同一条约束）。装 allow 时逐名探测
 * `ctx.tools.get(name, agent)`，本平台没有的那些（Windows 上没有 bash）自动跳过
 * —— 一个不存在的名字不会把整条 allow 弄挂。
 */
export const PURE_KEEP_TOOLS = Object.freeze([
  /* 文件：读 / 写 / 改 / 搜（dsh-tool-fs、dsh-tool-fs-search、dsh-tool-str-replace-editor） */
  'read',
  'write',
  'edit',
  'str_replace_editor',
  'glob',
  'grep',
  /* 命令（dsh-tool-pwsh / dsh-tool-bash，按平台各挂一只） */
  'pwsh',
  'bash',
  /* 联网（dsh-tool-web） */
  'web_search',
  'web_fetch',
  /* 换工作目录：读写都要用，schema 很小 */
  'working_directory',
])

/** 本台运行时是否跑纯净模式的工具白名单档。 */
export function pureToolsOn(env) {
  return String((env || process.env)[PURE_TOOLS_ENV] || '') === '1'
}

/**
 * 可裁名单（唯一真源）：不在这份名单里的名字一律按垃圾丢弃 —— 宿主传来的字符串
 * 绝不允许原样灌进运行时，更不允许拿它去 restrict() 没见过的名字。
 * 新增可裁工具时只改这里，并在渲染层 app-nodes.js 的 agentHiddenToolNames() 里给出
 * 它的触发条件（两边由 test/smoke-token-budget.js 的名单一致性断言钉住）。
 */
export const HIDEABLE_TOOLS = Object.freeze([
  /* MTNode 自有（注册口直接跳过） */
  'mtnode_app',
  'mtnode_assets',
  'mtnode_canvas_edit',
  'mtnode_canvas_get',
  'mtnode_db',
  'mtnode_vision',
  /* 本地媒体（media-plugin.mjs）：转写靠宿主语音服务、ffmpeg 会起子进程，
     两项各自对应一个许可位（media_asr / media_ffmpeg），被拒就整只不注册。
     audio_subtitle（字幕：cues + SRT/VTT）与 audio_transcribe 同属 media_asr。 */
  'audio_transcribe',
  'audio_subtitle',
  'ffmpeg',
  /* 长周期任务状态工具（app-longtask.js 造的伪节点之外一律不注册）；
     lt_memory 已下线 —— 长期记忆的沉淀改走 mtnode_facts（AI 事实库）。 */
  'lt_state',
  /* 会话自己的浏览器（browser-plugin.mjs 的注册口）：整族一起裁才有意义 ——
     某个入口被拒时剩下的也就干不成活，所以一族一个判据（整族不注册）。
     画布节点 / 长任务未授权环节走 MTNODE_NO_BROWSER（纯净模式已不裁工具，见 pure-prompt.mjs），
     整档闸在插件里先判；这里留着是为了让「工具许可被拒」也能落到同一份白名单上。 */
  'browser_launch',
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_eval',
  'browser_wait',
  'browser_screenshot',
  'browser_tabs',
  'browser_network',
  'browser_help',
  'browser_release',
  /* dsh 引擎自带（agent 作用域 restrict 摘除） */
  /* 识图只留一个入口：引擎自带的 read_image 无条件摘掉，看图一律走 mtnode_vision
     （它才有宿主审批与多模态后端路由）。判据在渲染层 agentDeniedToolNames 里是无条件的。 */
  'read_image',
  'ask_user_question',
  'create_goal',
  'get_goal',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'send_message',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
])

/** 名单里的名字都只允许 [a-z0-9_]：非法字符整条丢弃（env 里不能出现分隔符歧义）。 */
const SAFE_NAME = /^[a-z0-9_]+$/

const HIDEABLE = new Set(HIDEABLE_TOOLS)

/**
 * 把任意输入（数组 / 逗号串 / 混着空项与重复项）归一成「规范名单」：
 * 只保留可裁名单里的名字，去重、按字典序排序 —— 顺序固定才谈得上稳定前缀。
 * @param {string|string[]|null|undefined} raw
 * @returns {string[]} 规范后的工具名数组
 */
export function normalizeHiddenTools(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',')
  const out = new Set()
  for (const item of list) {
    const name = String(item == null ? '' : item).trim()
    if (!name || !SAFE_NAME.test(name)) continue
    if (!HIDEABLE.has(name)) continue
    out.add(name)
  }
  return Array.from(out).sort()
}

/** 规范名单 → spawn env 值（空数组 = 空串 = 不裁，网关侧据此 delete 掉 env）。 */
export function hiddenToolsEnvValue(names) {
  return normalizeHiddenTools(names).join(',')
}

/**
 * 运行时侧唯一读点：从 env 解析本台运行时的隐藏集合。
 * env 缺席 / 空 / 全非法 → 空集合（行为与未接入本能力时一字不差）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {Set<string>}
 */
export function hiddenToolsFromEnv(env) {
  let raw = ''
  try {
    raw = String((env || process.env)[HIDE_ENV] || '')
  } catch {
    return new Set()
  }
  return new Set(normalizeHiddenTools(raw))
}

/** 某个工具本轮是否该完全不存在（注册口用）。 */
export function isToolHidden(name, hidden) {
  const set = hidden || hiddenToolsFromEnv()
  return set.has(String(name || ''))
}
