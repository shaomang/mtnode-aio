/**
 * 按运行裁剪可见工具集（mtnode-tool-visibility · 跑在 dsh 运行时进程内）。
 *
 * gateway.mjs 在 spawn 时按本轮 run 参数把「这一轮根本不该存在的工具」算成一份规范
 * 名单，经 env MTNODE_HIDE_TOOLS 下达（名单同时进 runtime key，所以一台运行时的可见集
 * 从头到尾只有一个形状，提示缓存不会被轮内改可见集打爆）。
 *
 * MTNode 自有的工具（画布 / 应用 / 识图 / 数据库）在各自插件的注册口就不注册了；
 * 引擎自带的工具（目标 / 任务清单 / 子代理 / 后台任务 / 提问）注册在 @deepseek-ai 的包里，
 * 我们改不到注册 —— 这里用官方给的口子 `ctx.tools.restrict({ deny })`：它需要
 * **agent 作用域**的 ctx（普通插件 ctx 调用会直接抛错，见 dsh-tools README），
 * 所以挂 `agent/created`，在每个 agent 的创建窗口里把 deny 装进它自己的层。
 * restrict 的语义是「过滤该作用域继承来的全局工具」，被摘掉的工具整份 schema 不再进请求；
 * 子 agent 沿作用域链继承同一条限制。
 *
 * 底线：
 *  · env 缺席 / 空 / 全非法 → 一个监听都不注册，行为与未接入时一字不差；
 *  · 只裁「这一轮该 agent 真看得见、且确实可裁」的名字（restrict 点未知名字会抛）；
 *  · 任何异常一律放弃裁剪照常起轮 —— 省 token 的通道绝不允许把任务跑挂。
 */

import { hiddenToolsFromEnv } from '../tool-visibility.mjs'

export const name = 'mtnode-tool-visibility'

export const inject = ['tools']

export function apply(ctx) {
  const hidden = hiddenToolsFromEnv()
  if (hidden.size === 0) return
  const want = Array.from(hidden)
  const done = new WeakSet()
  let announced = false

  ctx.on('agent/created', ({ agent }) => {
    if (!agent || done.has(agent)) return
    done.add(agent)
    try {
      restrictFor(agent)
    } catch (err) {
      /* 裁剪失败 = 回到今天的满负载可见集，绝不因此让这一轮起不来 */
      noteFail(err)
    }
  })

  /** 装一条 deny 掩码；失败时退化成逐个名字试，只放弃装不上的那些。 */
  function restrictFor(agent) {
    const visible = want.filter((n) => isRestrictable(ctx, agent, n))
    if (visible.length === 0) return
    const ac = agent.ctx
    if (!ac || !ac.tools || typeof ac.tools.restrict !== 'function') return
    let firstErr = null
    try {
      ac.effect(() => ac.tools.restrict({ deny: visible }), 'mtnode-tool-visibility()')
      announceOnce(visible)
      return
    } catch (err) {
      firstErr = err
    }
    /* 整条掩码装不上（多半是名单里混了一个不可裁的名字）→ 退化成逐个试，
       只放弃真装不上的那些；一个都没装上才报「跳过裁剪」。 */
    const each = []
    for (const toolName of visible) {
      try {
        ac.effect(() => ac.tools.restrict({ deny: [toolName] }), 'mtnode-tool-visibility()')
        each.push(toolName)
      } catch {
        /* 这个名字装不上（作用域层不允许裁）→ 跳过，其余照裁 */
      }
    }
    if (each.length) announceOnce(each)
    else noteFail(firstErr)
  }

  /** 每进程只报一行：可见集改动值得留痕，但不该刷屏。 */
  function announceOnce(names) {
    if (announced) return
    announced = true
    try {
      process.stderr.write(`[tool-hide] deny=${names.join(',')}\n`)
    } catch {
      /* 无 stderr 也无需在意 */
    }
  }

  function noteFail(err) {
    if (announced) return
    try {
      process.stderr.write(`[tool-hide] 跳过裁剪: ${String((err && err.message) || err)}\n`)
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 该 agent 现在看得见、且属于「继承来的全局工具」（restrict 只裁这一类）吗？
 * get(name, agent) 只判可见，own-layer 的工具也可见却不可裁 —— 那种名字点名进 restrict
 * 会直接抛，所以两处都问一遍；问不动就保守返回 false（不裁 = 行为不变）。
 */
function isRestrictable(ctx, agent, name) {
  try {
    const tools = ctx.tools
    if (!tools || typeof tools.get !== 'function') return false
    if (tools.get(name, agent) === undefined) return false
    const view = typeof tools.view === 'function' ? tools.view(agent) : null
    if (view && view.restrictableNames && typeof view.restrictableNames.has === 'function') {
      return view.restrictableNames.has(name)
    }
    return true
  } catch {
    return false
  }
}
