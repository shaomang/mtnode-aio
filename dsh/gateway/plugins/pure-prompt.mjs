/**
 * 会话「纯净模式」（renderer 会话输入区的按钮开启）：
 * 当 MTNODE_PURE=1 时，把系统提示清成「只剩引擎机制 + 纯粹的用户输入」——
 * sections / contexts 全空、工具只保留联网搜索类，省 token 且结果确定。
 * 环境变量由 gateway.mjs 的 getRuntime 按 run 参数 pure 注入；
 * runtime key 已含 pure 标记，纯净 / 非纯净运行不会复用同一台运行时，
 * 因此本插件的 apply 阶段只对 pure 运行时生效。
 */
export const name = 'pure-prompt'

export const inject = ['systemPrompt']

function pureOn() {
  return String(process.env.MTNODE_PURE || '') === '1'
}

/** 与 bongochat-prompt 同口径：只认联网搜索类工具名。 */
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

export function apply(ctx) {
  /* 上下文提供方（AGENTS.md 指令、runtime context 等）根本不求值：
     在 apply 阶段登记 suppressor，比在 waterfall 里丢结果更省也更确定
     ——引擎会跳过全部 context provider 的求值，并在 waterfall 之后
     强制 contexts: []。 */
  if (pureOn()) ctx.systemPrompt.suppressRuntimeContext()

  /* prepend 注册 = 站到 cordis waterfall 的「最外层」。
     必须如此：waterfall 里先注册者是外层，它 await next() 之后仍可改写内层结果。
     本插件原先挂在最后（最内层），清空的 sections 会被 bongochat-prompt /
     router-bootstrap 等外层监听器覆盖掉，纯净模式随之失效。 */
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    if (!pureOn()) return assembled
    /* sections 直接返回空数组，不再按名字过滤（harness:identity /
       deployment:persona / tool:* 引导段 / plan-mode 段…一并清除）。
       刻意不依赖段名匹配：引擎升级后段名一变，按名过滤就会静默失效。

       空 sections 不会破坏子代理的 structured-output —— 该提示是
       complete: true 段，由引擎在 waterfall 之后恢复为唯一 sections
       （见 SystemPrompt.assemble：sections = [completeSection]）。
       后人勿把这里改回「保留若干段」或按名过滤。 */
    return {
      ...assembled,
      sections: [],
      contexts: [],
      tools: (assembled.tools || []).filter((t) => t && isWebTool(t.name)),
    }
  }, { prepend: true })
}
