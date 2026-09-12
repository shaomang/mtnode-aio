// 思考强度按 run 下发（mtnode-effort · 跑在 dsh 运行时进程内）。
//
// gateway（gateway.mjs）每轮 run 按路由能力表把宿主档位归一成「生效档」，经
// env MTNODE_EFFORT 注入 spawn 的运行时（runtime key 已含档位，换档会冷起新进程）。
// 本插件读该 env，在每个 agent 步骤的 agent/request waterfall 上把模型请求的
// reasoningEffort 提案成本档 —— 这是 llm-deepseek / llm-pi-ai 两条适配器路由都能
// 吃到的统一下发通道（SDK RunOptions 没有档位字段，settings 段只有 llm-deepseek
// 会读，pi-ai 路由因此此前思考档完全不生效）。
//
// 适配器在 prepareCall 里按「精确模型能力」校验档位，不支持的值会在网络 I/O 前
// UNSUPPORTED_REASONING_EFFORT 硬失败（dsh-llm 明确不做自动夹紧），所以这里先经
// ctx.llm 解析精确模型能力（pi-ai 的 getSupportedThinkingLevels 经 llm 的 reasoning
// 元数据暴露）再夹到最近可支持档；解析失败或模型无 reasoning 能力 → 不下发档位，
// 沿用适配器/提供方默认。DeepSeek 官方路由能力固定（off/low/high/max），无需动态解析。
//
// env 缺席 = 本插件 no-op，行为与接入前一字不变（降级保底）。推理规则与
// dsh/gateway/reasoning-effort.mjs（纯函数，codex reasoning_effort_for_request 式）
// 共享同一套档位/回退链；本文件只 import node 内置与那个纯模块。

import { effortForModelEfforts } from '../reasoning-effort.mjs'

export const name = 'mtnode-effort'

export const inject = ['llm']

function envEffort() {
  return String(process.env.MTNODE_EFFORT || '').trim()
}

export function apply(ctx) {
  const want = envEffort()
  if (!want) return
  /* agent/request 是普通（非 scope-filtered）waterfall:注册在插件 ctx(无 scope 标记)
     的监听器会被 scope carrier 的 filter 放行,因此能收到每个 agent 的每一步请求。
     语义同 dsh 的 installModelSelection:await next() 拿当前提案,返回改过的提案。 */
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (!resolved || typeof resolved !== 'object') return resolved
    const { provider, model } = resolved
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
      return resolved
    }
    const effort = await supportedEffortFor(ctx, provider, model, want)
    if (!effort) return resolved
    if (resolved.reasoningEffort === effort) return resolved
    return { ...resolved, reasoningEffort: effort }
  })
}

/* 把 env 目标档夹到精确模型能力:DeepSeek 官方固定;其余尽力经 ctx.llm 解析。 */
async function supportedEffortFor(ctx, provider, model, want) {
  if (provider === 'deepseek-official') {
    /* llm-deepseek 适配器能力 off/low/high/max;off = 会话「思考强度 · 无」，命中即关思考 */
    return effortForModelEfforts(want, ['off', 'low', 'high', 'max'])
  }
  try {
    const llm = ctx && ctx.llm
    if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
    const info = await llm.resolveModelInfo(provider, model)
    const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
      ? info.reasoning.efforts
          .map((e) => (e && typeof e.id === 'string' ? e.id : ''))
          .filter(Boolean)
      : []
    return effortForModelEfforts(want, efforts)
  } catch {
    /* 解析失败(目录不可用等):保守不下发,沿用适配器默认 —— 绝不盲发档位 */
    return undefined
  }
}
