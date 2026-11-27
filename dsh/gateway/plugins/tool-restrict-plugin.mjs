/**
 * 按运行裁剪可见工具集（mtnode-tool-visibility · 跑在 dsh 运行时进程内）。
 *
 * gateway.mjs 在 spawn 时按本轮 run 参数把「这一轮根本不该存在的工具」算成一份规范
 * 名单，经 env MTNODE_HIDE_TOOLS 下达（名单同时进 runtime key，所以一台运行时的可见集
 * 从头到尾只有一个形状，提示缓存不会被轮内改可见集打爆）。
 *
 * 纯净模式走同一条口子：env MTNODE_PURE_TOOLS=1 时，按
 * tool-visibility.mjs 的 PURE_DROP_TOOLS 装 `restrict({ deny })` —— 只摘 MTNode 自己
 * 注入的那些工具（画布 / 数据库 / 识图子代理 / 浏览器 / 媒体 / 长任务 / 素材…）。
 * dsh 引擎自带的工具（读 / 写 / 命令 / 联网 / read_image 识图 / 待办 / 子代理 / 提问…）
 * 一律保留：纯净轮的能力面与 dsh 独立运行基本一致（用户口径 · 本轮修正）。
 * 以前这里是 `restrict({ allow })` 的十一只白名单，把 read_image 与引擎工具一起挡掉，
 * 用户实报「纯净模式下识图用不了」就是那一档造成的。
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

import { hiddenToolsFromEnv, pureToolsOn, PURE_DROP_TOOLS } from '../tool-visibility.mjs'

export const name = 'mtnode-tool-visibility'

export const inject = ['tools']

export function apply(ctx) {
  const hidden = hiddenToolsFromEnv()
  /* 纯净模式（MTNODE_PURE_TOOLS=1）：只摘 PURE_DROP_TOOLS（MTNode 自己注入的工具），
     引擎自带的读写 / 命令 / 联网 / 识图 / 待办 / 子代理全部保留 —— 与 dsh 独立运行一致。
     与 hide 名单互斥：纯净档自带整份「要摘的名字」，两份名单叠起来只会让
     「纯净轮到底剩了什么」说不清。 */
  const pureDrop = pureToolsOn()
  if (hidden.size === 0 && !pureDrop) return
  const want = pureDrop ? Array.from(PURE_DROP_TOOLS) : Array.from(hidden)
  const done = new WeakSet()
  let announced = false

  ctx.on('agent/created', ({ agent }) => {
    if (!agent || done.has(agent)) return
    done.add(agent)
    try {
      restrictFor(agent, want)
    } catch (err) {
      /* 裁剪失败 = 回到今天的满负载可见集，绝不因此让这一轮起不来 */
      noteFail(err)
    }
  })

  /**
   * 装一条 deny 掩码（纯净模式与按轮隐藏共用）：同名工具整份 schema 不再进请求。
   *
   * 逐名探测存在性再装：restrict 点名一个未知 / 不可裁的名字会整条抛错。
   * 这里失败是**安全**的（工具照旧可见，不会像 allow 那样把工具裁空），
   * 但整条掩码装不上时仍退化成逐个名字试，能摘几个是几个。
   */
  function restrictFor(agent, names) {
    const ac = agent.ctx
    if (!ac || !ac.tools || typeof ac.tools.restrict !== 'function') return
    const visible = names.filter((n) => isRestrictable(ctx, agent, n))
    if (visible.length === 0) return
    let firstErr = null
    try {
      ac.effect(() => ac.tools.restrict({ deny: visible }), 'mtnode-tool-visibility()')
      announceOnce('deny=' + visible.join(','))
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
    if (each.length) announceOnce('deny=' + each.join(','))
    else noteFail(firstErr)
  }

  /** 每进程只报一行：可见集改动值得留痕，但不该刷屏。 */
  function announceOnce(label) {
    if (announced) return
    announced = true
    try {
      process.stderr.write(`[tool-hide] ${label}\n`)
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
