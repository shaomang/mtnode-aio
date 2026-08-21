'use strict'
/**
 * afterFileEdit: mark that MTNode runtime sources changed → need agent-rebuild.
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

function norm(p) {
  return String(p || '').replace(/\\/g, '/')
}

function shouldRebuild(filePath) {
  const p = norm(filePath)
  if (!p) return false
  if (/(^|\/)(node_modules|dist|dist-temp|\.git|__pycache__)(\/|$)/i.test(p))
    return false
  if (/(^|\/)\.cursor(\/|$)/i.test(p)) return false
  if (/\.(md|txt|png|jpg|jpeg|gif|webp|ico|map)$/i.test(p)) return false
  if (/(^|\/)(guides|ext-repo|store-saas|agent-transcripts)(\/|$)/i.test(p))
    return false
  /* runtime / pack inputs */
  if (
    /(^|\/)(renderer|dsh|pet|pet-pack|music3|music3-pack|h3|h3-pack|plugins|forum)(\/|$)/i.test(
      p,
    )
  )
    return true
  if (
    /(^|\/)(main\.js|preload\.js|updater\.js|crash-report\.js|build\.json|package\.json|version|installer\.nsh)$/i.test(
      p,
    )
  )
    return true
  if (/\.(js|cjs|mjs|html|css|json)$/i.test(p) && !/(\/scripts\/stage-)/i.test(p))
    return true
  return false
}

;(async () => {
  let input = {}
  try {
    const raw = await readStdin()
    if (raw.trim()) input = JSON.parse(raw)
  } catch {
    process.stdout.write('{}')
    process.exit(0)
  }
  const filePath = input.file_path || input.filePath || ''
  if (!shouldRebuild(filePath)) {
    process.stdout.write('{}')
    process.exit(0)
  }
  const root =
    (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) ||
    process.cwd()
  const dir = path.join(root, '.cursor')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'mtnode-rebuild-needed'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          file: filePath,
          conversation_id: input.conversation_id || null,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch {
    /* ignore */
  }
  process.stdout.write('{}')
})()
