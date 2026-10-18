/**
 * 会话主题标题（MTNode）：替换引擎自带的 session-title-first-prompt-llm。
 *
 * 为什么要有这一层：
 *   · 引擎的 first-prompt provider 把「首条用户消息」整条塞给辅助模型，而 MTNode 的
 *     首条消息常是整份宿主包装（旧版绑定会话甚至是【开发任务书】全文，十几 KB），
 *     一旦超过 maxInputBytes 就直接抛错，会话标题永远停在首句截断。
 *   · 用户口径（本次需求）：新会话确定需求后自动总结成 ≤20 字的主题名写回左栏；
 *     绑定会话保留「开发 · 」前缀由渲染层负责；用户手改过的标题由渲染层 titleLocked 挡。
 *
 * 本插件只做「送什么进模型」这一件事：从首条消息里提纯出真正的需求 / 范围段
 * （普通会话就是整条消息），再交给引擎的 executeSessionTitleLlm 走既有路由、
 * 字节闸、超时与日志；标题长度目标由本插件配置（默认 8 词 / 20 个汉字）。
 */

import z from '@deepseek-ai/schemastery'
import { SessionTitleProviderId, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import {
  SessionTitleLlmConfigFields,
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
} from '@deepseek-ai/dsh-session-title-llm'

export const name = 'mtnode-session-title'
export const inject = ['sessionTitle', 'llm']

const DEFAULT_TARGET_WORDS = 8
const DEFAULT_TARGET_CJK = 20
/* 放宽后的输入上限：只送提纯后的需求段，正常几百字节；留足粘贴长需求的余量。 */
const DEFAULT_MAX_INPUT_BYTES = 16384

export const Config = z.object({
  targetWords: z.number().step(1).min(1).default(DEFAULT_TARGET_WORDS),
  targetCjkCharacters: z.number().step(1).min(1).default(DEFAULT_TARGET_CJK),
  maxInputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INPUT_BYTES),
  maxOutputTokens: z.number().step(1).min(1).default(64),
  timeoutMs: z.number().step(1).min(1).default(60000),
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

/* 宿主包装里「真正是需求」的那几行（中英两套，界面语言会切换） */
const DEMAND_HEADS = ['本次开发需求：', '用户指定的细化范围：']
/* 段落结束标志：空行、下一个字段头、任务书的分节标题 */
const SECTION_STOPS = ['\n\n', '\n【', '\n- ', '\n## ', '\n# ']

/** 取「本次开发需求 / 细化范围」之后那一段；没有则返回 ""。 */
function demandSection(text) {
  for (const head of DEMAND_HEADS) {
    const at = text.indexOf(head)
    if (at < 0) continue
    let body = text.slice(at + head.length)
    for (const stop of SECTION_STOPS) {
      const end = body.indexOf(stop)
      if (end >= 0) body = body.slice(0, end)
    }
    body = body.trim()
    if (body) return body
  }
  return ''
}

/**
 * 主题原料：绑定会话取需求 / 范围段；普通会话取整条首条消息。
 * 旧形态（整份任务书塞进首条消息）里提不出需求段时返回 ""，由调用方保留占位标题。
 */
export function themeSourceOf(raw) {
  const text = String(raw == null ? '' : raw)
  if (!text.trim()) return ''
  const demand = demandSection(text)
  if (demand) return demand
  /* 旧形态绑定会话：整条是【系统设定】/【开发任务书】包装，截标题毫无意义 */
  const head = text.trimStart()
  if (head.startsWith('【系统设定】') || head.startsWith('【开发任务书】')) {
    const at = head.indexOf('【内容】')
    if (at >= 0) {
      const body = head.slice(at + '【内容】'.length).trim()
      const inner = demandSection(body)
      return inner || body
    }
    return ''
  }
  return text.trim()
}

/** 按 UTF-8 字节上限截断（不切坏多字节字符）。 */
export function clampToBytes(text, maxBytes) {
  const s = String(text || '')
  if (!maxBytes || Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
  }
  return out
}

function systemPrompt(config) {
  return [
    'Create a concise title for an AI assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of the language of those messages, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    `Name the actual subject or task, not a greeting or a meta phrase. Aim for at most ${config.targetCjkCharacters} CJK characters, or about ${config.targetWords} words in non-CJK languages.`,
    'If the messages give little to name, still return a short best-effort title instead of explaining.',
  ].join('\n')
}

function frameMessages(text) {
  return `Generate the session title from this human message:\n${JSON.stringify([{ role: 'user', text }])}`
}

const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

function titleFromOutput(text) {
  const line =
    String(text || '')
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.marker
  const inner = groups?.inner
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

function titleFromResponse(response) {
  if (response.finish.kind === 'tool-calls')
    throw new Error('session-title-theme: title output must contain text only')
  if (response.finish.kind === 'max-tokens')
    throw new Error('session-title-theme: title output reached maxOutputTokens')
  if (response.blocks.some((block) => block.type === 'tool-call'))
    throw new Error('session-title-theme: title output must contain text only')
  const title = normalizeSessionTitle(
    titleFromOutput(
      response.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' '),
    ),
    Number.MAX_SAFE_INTEGER,
  )
  if (!title) throw new Error('session-title-theme: title model produced no text')
  return title
}

export function apply(ctx, config) {
  const cfg = {
    targetWords: DEFAULT_TARGET_WORDS,
    targetCjkCharacters: DEFAULT_TARGET_CJK,
    maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
    maxOutputTokens: 64,
    timeoutMs: 60000,
    ...(config || {}),
  }
  const execution = resolveSessionTitleLlmConfig({
    maxInputBytes: cfg.maxInputBytes,
    maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutMs,
    ...(cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : {}),
  })
  const titleProvider = SessionTitleProviderId(name)

  try {
    ctx.sessionTitle.register({
      id: titleProvider,
      automatic: 'first-prompt',
      async generate(request) {
        const first = request && Array.isArray(request.messages) ? request.messages[0] : undefined
        if (first === undefined) throw new Error('session-title-theme: needs one human message')
        const raw = typeof first === 'string' ? first : first && first.text
        const source = clampToBytes(themeSourceOf(raw), execution.maxInputBytes)
        /* 提不出主题（旧形态包装且找不到需求段）：不硬造标题，交给渲染层的占位名 */
        if (!source) throw new Error('session-title-theme: no theme source in the first message')
        const response = await executeSessionTitleLlm(
          ctx,
          execution,
          request,
          titleProvider,
          {
            system: systemPrompt(cfg),
            input: frameMessages(source),
            messageSeqs: [first.seq],
            selectReasoningEffort: (model) => model.reasoning?.efforts[0]?.id,
          },
        )
        return { title: titleFromResponse(response), messageSeqs: [first.seq], model: response.model }
      },
    })
  } catch (error) {
    /* 引擎的标题服务只允许一个 provider：用户若在设置里把 base 的 session-title-llm
       重新启用，这里的注册会撞车。宁可整只让位（warn 一行，会话照跑），也不让插件
       装载失败拖垮网关。 */
    ctx.logger?.warn?.(
      `mtnode-session-title: provider not registered (${String(error)}) — engine default stays in charge`,
    )
  }
}
