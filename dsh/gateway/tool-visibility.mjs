/**
 * 按运行裁剪可见工具集 —— 网关与运行时插件共用的唯一真源。
 *
 * 每一次模型调用都把「全部可见工具的定义」重发一遍（优化前实测固定前缀 tools ≈ 98K 字符、
 * 空会话首步 32K token，且每一步都付）。所以「这一轮根本不可能用的工具」应该整个不发：
 *  · 我们自己注册的工具（画布 / 应用 / 识图 / 数据库）→ 在插件的注册口直接不注册；
 *  · dsh 引擎自带的工具（目标 / 任务清单 / 子代理 / 后台任务 / 提问）→ 注册在引擎包里，
 *    改不动注册，就用 ctx.tools.restrict({ deny }) 在 agent 作用域把它们从可见集摘掉
 *    （dsh-tools 明确：被 restrict 隐藏的工具整份 schema 不再进请求）。
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
 * 可裁名单（唯一真源）：不在这份名单里的名字一律按垃圾丢弃 —— 宿主传来的字符串
 * 绝不允许原样灌进运行时，更不允许拿它去 restrict() 没见过的名字。
 * 新增可裁工具时只改这里，并在渲染层 app-nodes.js 的 agentHiddenToolNames() 里给出
 * 它的触发条件（两边由 test/smoke-token-budget.js 的名单一致性断言钉住）。
 */
export const HIDEABLE_TOOLS = Object.freeze([
  /* MTNode 自有（注册口直接跳过） */
  'mtnode_app',
  'mtnode_canvas_edit',
  'mtnode_canvas_get',
  'mtnode_db',
  'mtnode_vision',
  /* dsh 引擎自带（agent 作用域 restrict 摘除） */
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
