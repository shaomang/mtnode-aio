/**
 * BongoChat 对话隔离：当 MTNODE_CHAT_ISOLATE=1 时，
 * 用人设环境变量覆盖 deployment:persona（settings.yaml 的 system-prompt
 * 段对 dsh-system-prompt 无效，不能依赖它），并裁掉非联网工具。
 */
export const name = 'bongochat-prompt'

export const inject = ['systemPrompt']

function isWebTool(name) {
  const n = String(name || '').toLowerCase()
  if (!n) return false
  return (
    n === 'web_search' ||
    n === 'web_fetch' ||
    n.includes('web_search') ||
    n.includes('web-search') ||
    n.includes('web_fetch') ||
    n.includes('web-fetch')
  )
}

function isolateOn() {
  return String(process.env.MTNODE_CHAT_ISOLATE || '') === '1'
}

function hostPersonaText() {
  return String(process.env.MTNODE_HOST_PERSONA || '').trim()
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    if (!isolateOn()) return assembled

    const text = hostPersonaText()
    return {
      ...assembled,
      sections: text
        ? [{ name: 'deployment:persona', text }]
        : [],
      contexts: [],
      tools: (assembled.tools || []).filter((t) => t && isWebTool(t.name)),
    }
  })
}
