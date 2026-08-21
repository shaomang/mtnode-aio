'use strict'
/**
 * stop: if runtime sources were edited this turn, force a follow-up rebuild.
 */
const fs = require('fs')
const path = require('path')

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf8')),
    )
  })
}

;(async () => {
  let input = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) input = JSON.parse(raw)
  } catch {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const status = String(input.status || '')
  const loopCount = Number(input.loop_count || 0)
  if (status && status !== 'completed') {
    process.stdout.write('{}\n')
    process.exit(0)
  }
  /* 只自动跟进一次，避免无限循环 */
  if (loopCount > 0) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const root =
    (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) ||
    process.cwd()
  const flag = path.join(root, '.cursor', 'mtnode-rebuild-needed')
  if (!fs.existsSync(flag)) {
    process.stdout.write('{}\n')
    process.exit(0)
  }

  const msg =
    'MTNode 源码已修改，但尚未完成「关闭程序 → compile → 重新执行」。' +
    '请立即在 pipeline-console 目录用 Shell 运行：scripts\\agent-rebuild.cmd' +
    '（或运行上级目录的 compile.cmd；二者均会关应用、编译、再启动）。' +
    '成功启动 MTNodeAIO.exe 后简要确认即可。'

  process.stdout.write(
    JSON.stringify({ followup_message: msg }) + '\n',
  )
})()
