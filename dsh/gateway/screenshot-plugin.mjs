// MTNode screenshot + annotation tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_screenshot: the agent asks the user to grab a region of THIS
// machine's screen, mark it up (rectangle / arrow / pen / text / numbered pin —
// each with a note) and hand the result back. The annotation is what makes the
// screenshot useful: 「这里要改成这样」 被写成图上的编号 + 清单，而不是一句模糊的
// 「截个图给我看」。
//
// Division of labour (same as canvas / asset / facts):
//   - the HOST (MTNode main process + overlay renderer) owns everything visible:
//     it asks the user first (询问窗 · 「开始标注 / 暂不」), freezes the screen of the
//     display under the cursor, runs the two-phase overlay (框选 → 标注), writes
//     <数据目录>\captures\shot-<时间戳>.png and puts the Markdown (image link +
//     numbered note list) on the clipboard;
//   - this plugin only forwards the call over the localhost TCP bridge and never
//     invents a path, a size or a note.
//
// Protocol (newline-delimited JSON, identical to ai-facts-plugin.mjs):
//   plugin → gateway: {t:'shot', id, sessionId, action:'grab', params:{reason}}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame we just sent)
//   gateway → plugin: {t:'shot-result', id, ok, result?, error?} | {t:'abort', id}
//
// result (success) = { ok:true, path, markdown, width, height,
//                     notes:[{ n, kind, x, y, w, h, text }] }
// result (user declined / pressed Esc) = { ok:false, canceled:true }
//   → the tool still returns a normal text result, so the model can carry on
//     (ask for a different area, or do the job without a picture).
//
// sessionId = exec.agent.id, the same stamp canvas-plugin.mjs carries. The gateway
// gates interaction frames on it, so an answer can never land in a run that did not
// ask for it; an unstamped frame is aborted (fail closed) rather than shown.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-screenshot'
export const inject = ['tools']

/* 用户要拿几分钟画两笔，别在工具层把人等死：宿主那边的浮层没有自己的超时，
   这一条只防「桥断了 / 网关关了」导致的无限挂起。 */
const SHOT_TIMEOUT_MS = 600000

const SHOT_DESC = `截屏标注（mtnode_screenshot）：请用户在本机截一块屏幕、顺手标注，或者让他直接给你一张已有的图片／一句话，再把结果交回来。
什么时候用：用户说「截个图看看」「这里不对」「照着这个改」，或你需要看见用户屏幕上的真实界面 / 报错 / 设计稿才能判断时。**不要**让用户自己截图再粘贴 —— 调用这个工具，弹出来的对话框会替他做完。
发生什么（不会一上来就抢屏）：先弹一只对话框，用户在里面写一句话（跟会话输入框一样，可留空），也可以填 / 选一张本机图片的绝对路径 ——
 · 填了路径 → 直接把那张图交回来（不拍屏，回执带 supplied:true）；
 · 只写一句话 → 这句话就是回执（没有图）；
 · 点「开始截图…」→ 才冻结鼠标所在那块屏，他框选区域 → 在裁剪图上用矩形 / 箭头 / 画笔 / 文字 / 编号图钉标注，每条标注能写一句备注；完成后 PNG 落到本机 captures 目录，剪贴板里同时写好 Markdown（图 + 编号清单）。
返回什么：{ ok, path, markdown, width, height, notes:[{n, kind, x, y, w, h, text}], text?, supplied? }。path 是本机绝对路径（可直接喂给读图能力）；markdown 里的坐标全部是裁剪图内像素、原点在左上角；notes 的 n 与图上红点数字一一对应；text = 用户在对话框里写的那句话（可能没有）；supplied:true = 这张图是用户给你的路径，不是本次截的。
用户取消（按 Esc / 点取消 / 对话框里什么都没给）：返回 canceled:true —— 这是正常收场，不要重试、不要再问一遍同样的东西，改用别的办法或直接问他要文字描述。
纪律：一张图只截一块区域（他框哪儿就是哪儿）；坐标与备注只转述工具返回的内容，不要自己编；图里的文字看不清就说看不清，别猜。`

export function apply(ctx) {
  /* 可见性：与 mtnode_facts / mtnode_assets 同形 —— 名字列在 tool-visibility.mjs 的
     HIDEABLE_TOOLS 里（将来可以按运行裁），宿主当前不把它写进任何 hideTools 名单，
     所以本档运行永远注册。 */
  if (isToolHidden('mtnode_screenshot')) return
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone */ }
    }
  }

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(err)
    }
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'shot-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'screenshot failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('screenshot aborted (task ended)'))
    }
  }

  const connect = () => {
    if (!Number.isInteger(port) || port <= 0) return
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      failAll(new Error('screenshot channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('screenshot channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    /* 发起轮盖章：agent.id 就是该 agent 所在 session 的 id（与 canvas / db / facts 同一契约），
       网关据此判归属；取不到 agent 发空串，由网关 fail closed 直接 abort。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'shot', id, sessionId, action, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('screenshot aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_screenshot',
    description: SHOT_DESC,
    parameters: {
      reason: {
        type: 'string',
        description:
          '给用户看的一句话：为什么要这张图 / 要看什么（会显示在对话框最上面，让他知道该框哪里、或者该给哪张图）。例如「看一下这个页面右侧被裁掉的按钮」。',
      },
    },
    timeoutMs: SHOT_TIMEOUT_MS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {}
        if (v.canceled) return [{ type: 'text', text: '用户取消了这次截图（canceled:true）—— 别再重试，换别的办法或直接问他。' }]
        /* 三句「这一轮到底拿到了什么」，免得模型对着一张不存在的图找东西：
         * 有图（截的 / 他给的）→ 指明路径；只有一句话 → 明说没有图。 */
        const lines = []
        if (v.path) lines.push(v.supplied ? '用户直接给了这张图（没有现场截）：' + v.path : '截图完成：' + v.path)
        else lines.push('用户这次没有给图。')
        if (v.text) lines.push('用户附言：' + v.text)
        lines.push(JSON.stringify(v))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const reason = String((args && args.reason) || '').slice(0, 300)
      return rpc('grab', { reason }, exec)
    },
  }))
}
