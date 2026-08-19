// electron-builder afterPack hook: copy the dsh gateway (including its
// node_modules tree) into resources/dsh/gateway.
//
// electron-builder applies .gitignore-based pruning to extraResources sources,
// which always drops dsh/gateway/node_modules (it must stay git-ignored).
// A manual copy after packing sidesteps that: plain Node child processes also
// cannot read asar, so the gateway has to live on the real filesystem anyway.
// See dsh/DESIGN.md "打包(Windows)".

'use strict'

const fs = require('fs')
const path = require('path')
const {
  ensureAppUpdateYml,
} = require('../scripts/ensure-app-update-yml.cjs')

/* 打包排除:未挂载能力留下的死重依赖。pi-ai 及其依赖(openai/@mistralai/
   @opentelemetry/@earendil-works)已随 llm-pi-ai 行恢复,不可排除;node-pty 是
   subprocess-local 的模块级导入,不可排除。dsh-attachment-local 模块级导入
   sharp(@img 为其平台二进制),随附件行挂载,同样不可排除。 */
const EXCLUDE_NODE_MODULES = []

exports.default = async function afterPack(context) {
  const appRoot = path.join(__dirname, '..')
  /* --dir 目标不是 nsis 时，electron-builder 不会写 app-update.yml；
     必须在 afterPack 补写，否则安装后 electron-updater 会 ENOENT。 */
  const updateYml = ensureAppUpdateYml(context.appOutDir, appRoot)
  console.log(`[after-pack] wrote ${updateYml}`)

  const src = path.join(__dirname, 'gateway')
  const dst = path.join(context.appOutDir, 'resources', 'dsh', 'gateway')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const copied = { dirs: 0, files: 0 }
  const excludedDirs = new Set()
  const excluded = new Set(EXCLUDE_NODE_MODULES)
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p)
      if (rel === '' ) return true
      const segs = rel.split(path.sep)
      if (segs.includes('.cache')) return false
      if (p.endsWith('.map')) return false
      const nmIdx = segs.indexOf('node_modules')
      if (nmIdx >= 0 && segs.length >= nmIdx + 2) {
        const scope = segs[nmIdx + 1] || ''
        const name = scope.startsWith('@')
          ? scope + '/' + (segs[nmIdx + 2] || '')
          : scope
        if (excluded.has(name) || excluded.has(scope)) {
          if (segs.length === nmIdx + 2) excludedDirs.add(scope)
          return false
        }
      }
      return true
    },
  })
  const count = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) { copied.dirs++; count(full) } else copied.files++
    }
  }
  count(dst)
  console.log(
    `[after-pack] dsh gateway copied: ${copied.dirs} dirs, ${copied.files} files, excluded ${excludedDirs.size} dead-weight packages → ${dst}`,
  )
}
