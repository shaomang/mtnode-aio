#!/usr/bin/env node
/* 只读诊断 · 零依赖（只用网关自带的 yaml）· 手动跑
 *
 * 用途：把 dsh 0.2 的**补丁叠加层**在进程外组合一遍，核对宿主托管的
 * `<DSH_HOME>/mtnode-settings.patch.yml` 抵达运行时后到底长什么样。
 * 起因（实测过的坑）：补丁按 id 是**整份替换 config**（dsh-app-boot 的 applyEntryPatches:
 * `target[key] = value`，不是深合并），所以托管的 permission 行只写 `defaultPreset` 时，
 * cordis.yml 里那张 presets 表会被整张抹掉 → 插件回落自带的 workspace-write /
 * danger-full-access 两个默认档 → 构造期 `resolve('mtnode-unattended')` 抛错：
 *   permission (@deepseek-ai/dsh-permission-presets): Error: permission: unknown preset
 *   "mtnode-unattended" (known: workspace-write, danger-full-access)
 * 本脚本复现/复核这件事：不写任何文件、不起运行时、不联网（纯函数组合）。
 *
 * 检查项（对每一份被审计的 mtnode-settings.patch.yml）：
 *   [1] 组合结果里有 permission 行，且 defaultPreset 落在档位表里
 *   [2] permission.config.presets 六档齐备，且每一档的 sandbox/approval 与
 *       dsh/gateway/cordis.yml 那张表逐字一致（两份表必须同源）
 *   [3] llm-deepseek 行有 reasoningEffort（托管叠加层确实打到了运行时行）
 *
 * 跑法：
 *   node scripts/audit-dsh-profile-patch.mjs              # 审计本机数据目录那份（复现现场）
 *   node scripts/audit-dsh-profile-patch.mjs --home <dir> # 审计指定 DSH_HOME
 * 退出码：0 = 全部通过；1 = 有失败项（或环境读不到）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GATEWAY = path.join(ROOT, 'dsh', 'gateway')
const CORDIS = path.join(GATEWAY, 'cordis.yml')
const ANCHOR = path.join(GATEWAY, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const APP_BOOT = path.join(GATEWAY, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')

const argv = process.argv.slice(2)
const homeArg = argv.indexOf('--home')
const HOME = homeArg >= 0 && argv[homeArg + 1]
  ? path.resolve(argv[homeArg + 1])
  : path.join(process.env.APPDATA || process.cwd(), 'pipeline-console', 'pipeline-console', 'dsh-home')
const MANAGED = path.join(HOME, 'mtnode-settings.patch.yml')

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra === undefined ? '' : ' — ' + extra)) }
}
const specOf = (v) => (v ? v.sandbox + '/' + v.approval : String(v))

console.log('dsh profile patch audit — home=' + HOME)
if (!existsSync(APP_BOOT)) {
  console.log('  ✗ 读不到 dsh-app-boot（先跑一次 dsh/gateway 的依赖安装）：' + APP_BOOT)
  process.exit(1)
}
/* yaml 是网关自己的依赖（根目录没有），按网关的 node_modules 解析 */
const yaml = createRequire(path.join(GATEWAY, 'noop.cjs'))('yaml')
const { loadProfile, composeEntries, loadOverlayPatches } = await import(pathToFileURL(APP_BOOT).href)

/* cordis.yml 的基础表（真源） */
const cordisRows = yaml.parse(readFileSync(CORDIS, 'utf8'))
const cordisPerm = (cordisRows || []).find((r) => r && r.id === 'permission')
const basePresets = (cordisPerm && cordisPerm.config && cordisPerm.config.presets) || {}
const baseIds = Object.keys(basePresets)

/* 与运行时同序的层：bundle 层 → cordis.yml → profile 用户层 → 托管叠加层 */
const profile = loadProfile('dsh', 'sdk', ANCHOR, HOME, {})
const layers = [
  ...profile.layers.flatMap((l) => l.patches),
  ...loadOverlayPatches('dsh', CORDIS),
  ...profile.patches,
  ...(existsSync(MANAGED) ? loadOverlayPatches('dsh', MANAGED) : []),
]
const warns = []
const entries = composeEntries(layers, (m) => warns.push(m))
const find = (list, id) => {
  for (const e of list) {
    if (e.id === id) return e
    if (e.group && Array.isArray(e.config)) { const hit = find(e.config, id); if (hit) return hit }
  }
  return null
}

console.log('  叠加层：bundle ×' + profile.layers.length + ' · cordis.yml · 用户层 · ' +
  (existsSync(MANAGED) ? 'mtnode-settings.patch.yml' : '(无托管叠加层，尚未跑过应用)'))
if (warns.length) console.log('  组合告警：' + warns.join(' | '))

const perm = find(entries, 'permission')
ok(!!perm, '[1] 组合结果里有 permission 行')
const cfg = (perm && perm.config) || {}
const presets = cfg.presets || {}
const ids = Object.keys(presets)
console.log('  permission.config = ' + JSON.stringify(cfg))
ok(!!cfg.defaultPreset, '[1] permission.defaultPreset 已写')
ok(ids.length > 0 && !!presets[cfg.defaultPreset], '[2] defaultPreset 落在档位表里（缺表就是 error: unknown preset 的由来）',
  'defaultPreset=' + String(cfg.defaultPreset) + ' 表内=' + ids.join(','))

ok(baseIds.length > 0, '[2] cordis.yml 的档位表可读（真源）', '表内=' + baseIds.join(','))
for (const id of baseIds) {
  ok(!!presets[id], '[2] 托管行带上档位 ' + id, '缺失 → 该档在运行时不存在，插件构造期抛错')
  ok(!!presets[id] && specOf(presets[id]) === specOf(basePresets[id]),
    '[2] ' + id + ' 的 sandbox/approval 与 cordis.yml 一致', specOf(presets[id]) + ' vs ' + specOf(basePresets[id]))
}
for (const id of ids) ok(baseIds.includes(id), '[2] 托管行没有 cordis.yml 之外的多余档位 ' + id)

const ds = find(entries, 'llm-deepseek')
ok(!!ds && !!(ds.config || {}).reasoningEffort, '[3] 托管叠加层打到了 llm-deepseek 行',
  ds ? JSON.stringify(ds.config).slice(0, 120) : 'no row')

console.log('\ndsh profile patch audit: pass ' + pass + ' / fail ' + fail)
process.exit(fail ? 1 : 0)
