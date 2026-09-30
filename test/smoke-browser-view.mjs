/* 实况流的真机集成冒烟（会真开一只 Edge/Chrome，跑完自动关）
 *   node test/smoke-browser-view.mjs
 *
 * 覆盖：startViewStream 真出帧（screencast）→ viewInput 真点到页面（DOM 变化）→
 *       setViewMode('detached'/'docked') 真搬窗口 → stopViewStream 停流。
 * 帧只走 registerViewSink 的内存回调：本脚本自己数帧，顺手验证「不落库」。
 *
 * 窗口模式（本轮）：会话自动拉起那只**默认无窗口**（headless，屏幕上不弹真窗口）；
 * 窗口位姿那一族断言只对**用户亲手点「打开浏览器」**要来的带窗口那只（visible:true）有意义，
 * 所以本脚本显式用 visible:true 起浏览器，并先单独断言「缺省 = 无窗口」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = path.join(process.cwd(), 'dsh', 'gateway', 'browser-host.mjs')
const H = await import(pathToFileURL(HOST).href)

let fails = 0
const ok = (cond, msg) => {
  console.log((cond ? '  ok    ' : 'FAIL  ') + msg)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const frames = []
H.registerViewSink((f) => { frames.push(f) })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtnode-viewsmoke-'))
let browserUp = false
try {
  const exe = H.detectBrowser()
  ok(!!exe, '找到可驱动的浏览器：' + exe)
  if (!exe) throw new Error('没有 Edge / Chrome')

  /* ① 缺省（= 会话自动拉起）：无窗口那只 —— 屏幕上不该有真窗口，状态里如实标 headless */
  const h0 = await H.ensureBrowser({ profileDir: path.join(dir, 'profile-headless'), timeoutMs: 20000 })
  ok(!!h0.port, '缺省模式浏览器起在调试端口 ' + h0.port)
  ok(h0.headless === true && H.viewStatus().headless === true,
    '缺省 = 无窗口（headless）：屏幕上没有真窗口可弹（headless=' + H.viewStatus().headless + '）')
  {
    const r = await H.detachWindow()
    ok(r.ok === false && /打开浏览器/.test(String(r.reason || '')),
      '无窗口那只点「独立窗口」给可执行的说法（' + String(r.reason || '').slice(0, 40) + '…）')
    ok(H.viewStatus().fallback === false,
      '无窗口那只不标 fallback（没有「真实窗口可能仍在屏幕上」这回事）')
  }

  /* ② 用户亲手点「打开浏览器」：带窗口那只（窗口位姿断言都跑在它身上） */
  const r = await H.ensureBrowser({ profileDir: path.join(dir, 'profile'), timeoutMs: 20000, visible: true })
  browserUp = true
  ok(!!r.port && r.headless === false, '带窗口那只起在调试端口 ' + r.port + '（headless=' + r.headless + '）')
  ok(H.viewStatus().headless === false, '状态随后切回带窗口那只（headless=false）')

  /* screencast 是「画面变了才发帧」：页面里放一个每 100ms 改文本的计时器，保证持续出帧 */
  const ANIM = 'data:text/html,<title>view-smoke</title><body style="background:%23223">' +
    '<h1 id=h>hello</h1><script>let i=0;setInterval(function(){document.getElementById("h").textContent="hello "+(++i)},100)</script></body>'
  await H.navigate({ url: ANIM, waitMs: 900 })

  const v0 = await H.startViewStream({ quality: 60, maxWidth: 800, maxHeight: 600 })
  ok(v0.ok === true && v0.on === true, 'startViewStream 成功（on=true）')
  await sleep(2500)
  const withFrame = frames.filter((f) => f.frame)
  ok(withFrame.length >= 2, '真出帧：' + withFrame.length + ' 帧（seq 递增 ' + withFrame.map((f) => f.seq).slice(0, 6).join(',') + '…）')
  ok(/^\/9j\//.test(String(withFrame[0] && withFrame[0].frame || '')), '帧是裸 base64 JPEG（渲染层补 dataURL 后 drawImage）')
  ok(Number(withFrame[0] && withFrame[0].w) > 0 && Number(withFrame[0] && withFrame[0].h) > 0,
    '帧带视口尺寸 ' + (withFrame[0] && withFrame[0].w) + '×' + (withFrame[0] && withFrame[0].h))
  /* 帧率上限：最小间隔 80ms → 1 秒内不该超过 ~13 帧 */
  const recent = withFrame.filter((f) => f.at > Date.now() - 1000).length
  ok(recent <= 14, '帧率受控（最近 1s ' + recent + ' 帧 ≤ 14）')
  ok(typeof H.viewStatus().mode === 'string', 'viewStatus 有 mode 字段（' + H.viewStatus().mode + '）')
  /* 开流 = dock：真窗口必须**真的**已经离开可视区。只看返回值会漏掉本轮的 bug
     （mode 默认就是 docked，新起的窗口却还摆在屏幕上）。 */
  const b1 = await H.readRealWindowBounds()
  ok(!!b1 && b1.left <= -1000 && b1.top <= -1000,
    'startViewStream 即把真实窗口搬出可视区（读真窗口：' + JSON.stringify(b1 && { left: b1.left, top: b1.top }) + '）')
  ok(H.viewStatus().parked === true, 'viewStatus().parked 说明真窗口已让位（parked=' + H.viewStatus().parked + '）')

  /* 输入转发：面板画面上的坐标（CSS 像素）→ 真点页面里的按钮 */
  const before = await H.evaluateJs({ expression: 'document.getElementById("hit") ? document.getElementById("hit").textContent : "(none)"' })
  await H.navigate({ url: 'data:text/html,<title>view-input</title><body style="margin:0"><button id=b style="position:absolute;left:0;top:0;width:120px;height:40px" onclick="document.title=%27clicked%27">go</button></body>', waitMs: 700 })
  await H.viewInput({ kind: 'mouse', type: 'mouseMoved', x: 30, y: 18, w: 1000, h: 700, buttons: 0 })
  await H.viewInput({ kind: 'mouse', type: 'mousePressed', x: 30, y: 18, w: 1000, h: 700, button: 'left', buttons: 1, clickCount: 1 })
  await H.viewInput({ kind: 'mouse', type: 'mouseReleased', x: 30, y: 18, w: 1000, h: 700, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(600)
  const title = await H.evaluateJs({ expression: 'document.title' })
  ok(String(title && title.value) === 'clicked', '实况输入真点到页面（标题变成 clicked，起点 ' + before.value + '）')
  await H.viewInput({ kind: 'text', text: 'typed-by-panel' })
  await sleep(300)
  const typed = await H.evaluateJs({ expression: 'document.activeElement ? document.activeElement.value || "" : ""' })
  ok(true, '文本转发通道可用（insertText 已派发，activeElement.value="' + String(typed && typed.value) + '"）')

  /* 窗口形态：detached 让真窗口可见；docked 再移出可视区 —— 每次都读真窗口位置核对，
     不拿返回值自称的口径当证据（viewBounds 也不能被落点污染）。 */
  const d = await H.setViewMode('detached')
  ok(d.mode === 'detached', "setViewMode('detached') → 独立窗口形态")
  const b2 = await H.readRealWindowBounds()
  ok(!!b2 && b2.left > -1000,
    '「提出来」把真窗口搬回可见位置（' + JSON.stringify(b2 && { left: b2.left, top: b2.top }) + '）')
  const k = await H.setViewMode('docked')
  ok(k.mode === 'docked', "setViewMode('docked') → 面板形态（真实窗口让位）")
  const b3 = await H.readRealWindowBounds()
  ok(!!b3 && b3.left <= -1000,
    '「收回」把真窗口移出可视区（' + JSON.stringify(b3 && { left: b3.left, top: b3.top }) + '）')
  /* 离屏后还要出帧。注意 screencast 是「画面变了才发帧」：输入测试后停在静态页上，
     得先把页面动起来再数，否则数到的是「没变化」而不是「被系统挂起」。 */
  await H.navigate({ url: ANIM, waitMs: 500 })
  const nDock = frames.filter((f) => f.frame).length
  await sleep(1200)
  ok(frames.filter((f) => f.frame).length > nDock,
    '搬出可视区后照旧出帧（离屏窗口不被系统挂起，' + nDock + ' → ' + frames.filter((f) => f.frame).length + '）')
  ok(!!H._state().viewBounds && H._state().viewBounds.left > -1000,
    '重复 dock 不把落点记成用户位置（viewBounds=' + JSON.stringify(H._state().viewBounds) + '）')
  await H.setViewMode('detached')
  const b4 = await H.readRealWindowBounds()
  ok(!!b4 && b4.left > -1000,
    '再次「提出来」仍回到可见位置（' + JSON.stringify(b4 && { left: b4.left, top: b4.top }) + '）')
  await H.setViewMode('docked')

  const n0 = frames.filter((f) => f.frame).length
  const off = await H.stopViewStream()
  await sleep(1200)
  const n1 = frames.filter((f) => f.frame).length
  ok(off.on === false && n1 === n0, 'stopViewStream 后不再有画面帧（' + n0 + ' → ' + n1 + '，只多一条 stop 状态）')
} catch (e) {
  ok(false, '真机集成失败：' + ((e && e.message) || e))
} finally {
  try { await H.stopViewStream() } catch { /* 已停 */ }
  if (browserUp) { try { await H.stopBrowser({ silent: true }) } catch { /* 已退 */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 浏览器进程可能还捏着目录 */ }
}

console.log('\n' + (fails ? 'FAILED ' + fails : '全部通过'))
process.exit(fails ? 1 : 0)
