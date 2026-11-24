/**
 * 按运行裁剪可见工具集（mtnode-tool-visibility · 跑在 dsh 运行时进程内）。
 *
 * gateway.mjs 在 spawn 时按本轮 run 参数把「这一轮根本不该存在的工具」算成一份规范
 * 名单，经 env MTNODE_HIDE_TOOLS 下达（名单同时进 runtime key，所以一台运行时的可见集
 * 从头到尾只有一个形状，提示缓存不会被轮内改可见集打爆）。
 *
 * 纯净模式走同一条口子的反向用法：env MTNODE_PURE_TOOLS=1 时，按
 * tool-visibility.mjs 的 PURE_KEEP_TOOLS 装 `restrict({ allow })` —— 除白名单
 * （读 / 写 / 命令 / 联网搜索）之外的工具整份 schema 都不发。实测纯净轮的系统提示
 * 已是 0 token，剩下的 23.7K 全在工具定义上，所以这一档才是「纯净模式省 token」
 * 真正生效的地方。
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

import { hiddenToolsFromEnv, pureToolsOn, PURE_KEEP_TOOLS } from '../tool-visibility.mjs'

export const name = 'mtnode-tool-visibility'

export const inject = ['tools']

export function apply(ctx) {
  const hidden = hiddenToolsFromEnv()
  /* 纯净模式（MTNODE_PURE_TOOLS=1）：反向保留白名单，除它之外一个工具 schema 都不发。
     与 hide 名单互斥 —— allow 已经是最强档，两个都装没有意义（allow ∩ deny 只会更小，
     反而让「纯净轮到底留了什么」说不清）。 */
  const pureKeep = pureToolsOn()
  if (hidden.size === 0 && !pureKeep) return
  const want = Array.from(hidden)
  const done = new WeakSet()
  let announced = false

  ctx.on('agent/created', ({ agent }) => {
    if (!agent || done.has(agent)) return
    done.add(agent)
    try {
      if (pureKeep) restrictToKeep(agent)
      else restrictFor(agent)
    } catch (err) {
      /* 裁剪失败 = 回到今天的满负载可见集，绝不因此让这一轮起不来 */
      noteFail(err)
    }
  })

  /**
   * 纯净模式：只留 PURE_KEEP_TOOLS（读 / 写 / 命令 / 联网搜索）。
   *
   * restrict 的 allow 语义是「只保留这些全局工具」，被排除的整份 schema 不再进请求
   * —— 这就是纯净轮省掉 23.7K token 的地方（实测见 tool-visibility.mjs 的注释）。
   * 逐名探测存在性：restrict 点名一个未知 / 不可裁的名字会整条抛错，那样纯净模式
   * 会静默退回全量（用户报过「纯净模式仍有大量 token」，所以这里绝不允许整条失败）。
   *
   * 护栏（比省 token 更重要）：allow 是「反向白名单」，探测漏掉一个名字 = 那个工具被
   * 裁掉。所以核心工具（read / write / 一只命令工具）探测不到时干脆整条不装 ——
   * 宁可按今天的全量跑，也不能让纯净会话读不了文件。
   */
  function restrictToKeep(agent) {
    const ac = agent.ctx
    if (!ac || !ac.tools || typeof ac.tools.restrict !== 'function') return
    const keep = PURE_KEEP_TOOLS.filter((n) => isRestrictable(ctx, agent, n))
    const hasCmd = keep.indexOf('pwsh') >= 0 || keep.indexOf('bash') >= 0
    if (keep.indexOf('read') < 0 || keep.indexOf('write') < 0 || !hasCmd) {
      noteFail(new Error('核心工具探测不到（read / write / 命令），跳过 allow 裁剪'))
      return
    }
    ac.effect(() => ac.tools.restrict({ allow: keep }), 'mtnode-pure-tools()')
    announceOnce('allow=' + keep.join(','))
  }

  /** 装一条 deny 掩码；失败时退化成逐个名字试，只放弃装不上的那些。 */
  function restrictFor(agent) {
    const visible = want.filter((n) => isRestrictable(ctx, agent, n))
    if (visible.length === 0) return
    const ac = agent.ctx
    if (!ac || !ac.tools || typeof ac.tools.restrict !== 'function') return
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
