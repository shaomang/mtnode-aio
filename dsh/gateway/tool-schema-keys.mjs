/**
 * 用户工具入参 → 模型可见 JSON Schema 属性名。
 *
 * 若干上游（Anthropic 兼容的 custom.input_schema、以及部分中转）要求
 * properties 的键匹配 ^[a-zA-Z0-9_.-]{1,64}$。内置工具库「随时可调用」条目
 * 用中文端子名（如 PDF路径），原样进 schema 会让整轮会话请求被拒，
 * 表现为更新后 AI 会话完全不能用。
 *
 * 本模块零依赖，网关进程与冒烟测试都能 import。
 */

export const TOOL_SCHEMA_PROP = /^[a-zA-Z0-9_.-]{1,64}$/

/**
 * @param {string} name 端子原名（可中文）
 * @param {number} index 入参下标（0 起）
 * @param {Set<string>} used 本工具已占用的 schema 键
 * @returns {string} 合法 schema 属性名；非法原名回落 arg<N>（与宿主 agentToolPrecheck 同源）
 */
export function toolSchemaPropKey(name, index, used) {
  const set = used || new Set()
  const i = Number.isFinite(Number(index)) && Number(index) >= 0 ? Math.floor(Number(index)) : 0
  const raw = String(name == null ? '' : name).trim()
  if (raw && TOOL_SCHEMA_PROP.test(raw) && !set.has(raw)) {
    set.add(raw)
    return raw
  }
  let n = i + 1
  let key = 'arg' + n
  while (set.has(key) || !TOOL_SCHEMA_PROP.test(key)) {
    n += 1
    key = 'arg' + n
  }
  set.add(key)
  return key
}

/**
 * 把模型按 schema 键传来的 args 折回端子原名，宿主仍按 p.name / arg<N> 取值。
 * @param {object} args
 * @param {{ schemaKey: string, name: string }[]} aliases
 */
export function remapToolCallArgs(args, aliases) {
  const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const out = Object.assign({}, src)
  const list = Array.isArray(aliases) ? aliases : []
  for (const a of list) {
    const schemaKey = a && a.schemaKey != null ? String(a.schemaKey) : ''
    const name = a && a.name != null ? String(a.name) : ''
    if (!schemaKey || schemaKey === name) continue
    if (out[name] === undefined && out[schemaKey] !== undefined) out[name] = out[schemaKey]
  }
  return out
}
