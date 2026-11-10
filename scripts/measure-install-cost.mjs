#!/usr/bin/env node
/**
 * measure-install-cost.mjs — 安装 / 更新成本基线口径（默认只读，不改任何东西）
 *
 * 为什么要有这个脚本：安装慢、更新慢这类结论只能靠同一把尺子反复量，凭印象说「变快了」
 * 没有意义。后续每一项优化（压缩档位、能力组瘦身、node_modules 归档、CDN、多连接下载、
 * Defender 排除项）都必须用本脚本前后各量一次，数字才可比。
 *
 * 量三样东西：
 *   1. 应用目录（默认 dist/win-unpacked）的文件数与字节数 —— 安装阶段真正要写盘的量。
 *      文件数比体积更要紧：一万六千个文件每个都要过一次安全软件实时扫描。
 *   2. 安装包体量 —— 用户要下载的量（含差分用的 .blockmap）。
 *   3. 一次真实 NSIS 静默安装的耗时（--install，默认不跑）—— 唯一能证明「安装变快了」的数字。
 *
 * 1.6.2 的实测基线（本机，SSD）：682.8 MB / 16,638 个文件，其中 resources/dsh 占
 * 16,028 个文件 / 271.2 MB；安装包 165.7 MB。
 *
 * 用法：
 *   node scripts/measure-install-cost.mjs                      # 只统计（默认，不动系统）
 *   node scripts/measure-install-cost.mjs --json=docs/install-cost.json
 *   node scripts/measure-install-cost.mjs --baseline=docs/install-cost.json   # 与基线对比
 *   node scripts/measure-install-cost.mjs --install             # 真装一次并计时，装完静默卸载
 *   node scripts/measure-install-cost.mjs --install --keep      # 装完保留（自己手动验）
 *   node scripts/measure-install-cost.mjs --install --upgrade   # 覆盖本机已有安装（会替换它）
 *   node scripts/measure-install-cost.mjs --install --dry-run   # 只打印将要执行的命令
 *
 * 可选参数：
 *   --app=<dir>        应用目录，默认 dist/win-unpacked
 *   --installer=<exe>  指定安装包，默认挑 dist 里与 version 同版本的那个（否则取最新）
 *   --top=<n>          顶层分解显示前 n 项，默认 8
 *   --dir=<path>       安装目标目录；不给则用注册表记录的 InstallLocation，
 *                      再没有就 %LOCALAPPDATA%\Programs\MTNodeAIO
 *   --timeout=<sec>    单次安装 / 卸载的超时，默认 900
 *   --json=<path>      把本次结果写成 JSON（供后续优化做 --baseline 对比）
 *   --baseline=<path>  读一份旧 JSON，打印各项差值
 *
 * 安装模式的两条安全前提（来自 installer.nsh，别绕过）：
 *   · customInit 会读注册表 InstallLocation 并沿用；本机已装时静默安装必然覆盖那个目录，
 *     所以默认拒绝执行，必须显式 --upgrade 表示「我知道会替换现有安装」。
 *   · 没有既有安装时它会落到 %LOCALAPPDATA%\Programs\MTNodeAIO（/D 不一定生效），
 *     所以装完一律回读「文件实际落在哪」，与预期不一致就照实打印，不假装成功。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const getOpt = (name, dflt = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const hasFlag = (name) => argv.includes(`--${name}`)

const APP_DIR = path.resolve(ROOT, getOpt('app', 'dist/win-unpacked'))
const TOP_N = Math.max(1, Number(getOpt('top', '8')) || 8)
const TIMEOUT_SEC = Math.max(30, Number(getOpt('timeout', '900')) || 900)
const JSON_OUT = getOpt('json', '') ? path.resolve(ROOT, getOpt('json', '')) : ''
const BASELINE = getOpt('baseline', '') ? path.resolve(ROOT, getOpt('baseline', '')) : ''
const DO_INSTALL = hasFlag('install')
const KEEP = hasFlag('keep')
const UPGRADE = hasFlag('upgrade')
const DRY_RUN = hasFlag('dry-run')
const DIR_OPT = getOpt('dir', '')

// 关注路径：安装文件数与体积的两个杠杆都在这棵树里
// （网关已归档成单个 resources/dsh/gateway-tree.mtgw，老的两层散树路径留在这里是为了
//   还能量归档化之前的安装包 —— 路径不存在时统计会跳过它）
const FOCUS = [
  'resources',
  'resources/dsh',
  'resources/dsh/gateway-tree.mtgw',
  'resources/dsh/gateway',
  'resources/dsh/gateway/node_modules',
  'resources/app.asar.unpacked',
]

// ---------- 小工具 ----------

const MB = (b) => b / 1024 / 1024
const fmtBytes = (b) => `${MB(b).toFixed(1)} MB`
const fmtNum = (n) => Number(n).toLocaleString('en-US')
const vlen = (s) => [...String(s)].reduce((a, ch) => a + (/[\u2e80-\uffff]/.test(ch) ? 2 : 1), 0)
const vpad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - vlen(s)))
const pctStr = (now, prev) => (prev > 0 ? `${(((now - prev) / prev) * 100).toFixed(1)}%` : '—')
const signedNum = (now, prev) => `${now - prev > 0 ? '+' : ''}${fmtNum(now - prev)}`

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(vlen(h), ...rows.map((r) => vlen(r[i] ?? ''))))
  const line = (cells) => '  ' + cells.map((c, i) => vpad(c ?? '', widths[i])).join('  ')
  console.log(line(headers))
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
}

function section(title) {
  console.log(`\n${title}`)
  console.log('─'.repeat(vlen(title)))
}

function splitCmd(cmdline) {
  const out = []
  let cur = ''
  let inQuote = false
  for (const ch of cmdline) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (!inQuote && /\s/.test(ch)) { if (cur) { out.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 目录度量 ----------

/**
 * 遍历一棵树，返回文件数、字节数、顶层分解与最大文件。
 * 只 stat 不读内容 —— 16k 个文件的统计在本机约 0.3s。
 */
function scanTree(root) {
  const top = new Map()
  let files = 0
  let bytes = 0
  let largest = null

  const walk = (dir, topName) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, topName || e.name)
        continue
      }
      if (!e.isFile()) continue // 符号链接等不计入，避免重复计数
      let st
      try { st = fs.statSync(p) } catch { continue }
      files += 1
      bytes += st.size
      const key = topName || '(根目录文件)'
      const row = top.get(key) || { name: key, files: 0, bytes: 0 }
      row.files += 1
      row.bytes += st.size
      top.set(key, row)
      if (!largest || st.size > largest.bytes) largest = { path: p, bytes: st.size }
    }
  }

  walk(root, null)
  return {
    dir: root,
    files,
    bytes,
    top: [...top.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files),
    largest,
  }
}

// ---------- 注册表：本机是否已装、装在哪 ----------

function decodeBuf(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { /* 非 UTF-8，退回本地代码页 */ }
  try { return new TextDecoder('gbk').decode(buf) } catch { /* 没有 ICU，只好按 latin1 */ }
  return buf.toString('latin1')
}

function runReg(args) {
  const r = spawnSync('reg', args, { encoding: 'buffer', windowsHide: true, timeout: 20000 })
  if (!r || r.status !== 0 || !r.stdout) return ''
  return decodeBuf(r.stdout)
}

/** 在 Uninstall 项里找 DisplayName 含 MTNode 的条目（HKCU 优先） */
function findInstalled() {
  for (const hive of ['HKCU', 'HKLM']) {
    const base = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
    const txt = runReg(['query', base, '/s', '/f', 'MTNode'])
    if (!txt) continue
    const blocks = []
    let cur = null
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (/^HKEY_/.test(line)) {
        cur = { key: line, values: {} }
        blocks.push(cur)
        continue
      }
      const m = /^\s{2,}(\S.*?)\s{4,}(REG_\w+)\s{4,}(.*)$/.exec(line)
      if (m && cur) cur.values[m[1]] = m[3]
    }
    for (const b of blocks) {
      if (!/Reinstall|Uninstall/i.test(b.key)) continue
      const name = b.values.DisplayName || ''
      if (!/MTNode/i.test(name)) continue
      const guid = b.key.split('\\').pop()
      // installer.nsh 读的是 Software\<GUID>\InstallLocation（不是 Uninstall 项）
      const locTxt = runReg(['query', `${hive}\\Software\\${guid}`, '/v', 'InstallLocation'])
      const locMatch = /InstallLocation\s+REG_\w+\s+(.+)/.exec(locTxt)
      return {
        hive,
        guid,
        displayName: name,
        version: b.values.DisplayVersion || '',
        installLocation: locMatch ? locMatch[1].trim() : '',
        quietUninstall: b.values.QuietUninstallString || '',
        uninstall: b.values.UninstallString || '',
        icon: b.values.DisplayIcon || '',
      }
    }
  }
  return null
}

// ---------- 安装包 ----------

function readVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'version'), 'utf8').trim() } catch { /* 退回 package.json */ }
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '' } catch { return '' }
}

function findInstaller(version) {
  const explicit = getOpt('installer', '')
  if (explicit) {
    const p = path.resolve(ROOT, explicit)
    return fs.existsSync(p) ? p : null
  }
  const distDir = path.join(ROOT, 'dist')
  let names = []
  try { names = fs.readdirSync(distDir).filter((n) => /^MTNodeAIO-Setup-.*\.exe$/i.test(n)) } catch { return null }
  if (!names.length) return null
  const exact = version && names.find((n) => n === `MTNodeAIO-Setup-${version}.exe`)
  if (exact) return path.join(distDir, exact)
  const withTime = names
    .map((n) => ({ n, t: fs.statSync(path.join(distDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return path.join(distDir, withTime[0].n)
}

// ---------- 计时执行 ----------

function spawnTimed(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, ...extra })
    }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      done({ error: err })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      done({ killed: true })
    }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); done({ error: err }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) })
  })
}

/** 轮询等某个文件出现 / 消失，返回等待毫秒数（超时返回 -1） */
async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return Date.now() - t0
    await sleep(stepMs)
  }
  return -1
}

function hasExe(dir) {
  try {
    return fs.readdirSync(dir).some((n) => /^MTNodeAIO\.exe$/i.test(n))
  } catch {
    return false
  }
}

function findUninstaller(dir) {
  try {
    const n = fs.readdirSync(dir).find((x) => /^Uninstall.*\.exe$/i.test(x))
    return n ? path.join(dir, n) : ''
  } catch {
    return ''
  }
}

// ---------- 安装 / 卸载计时 ----------

async function runInstallBench(installerPath, version) {
  const installed = findInstalled()
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const fallbackDir = path.join(localAppData, 'Programs', 'MTNodeAIO')
  const expectedDir = path.resolve(DIR_OPT || installed?.installLocation || fallbackDir)

  section('安装计时（--install）')
  console.log(`  安装包        ${installerPath}${version ? `（version=${version}）` : ''}`)
  if (installed) {
    console.log(`  本机已装      ${installed.displayName} @ ${installed.installLocation || '(注册表无 InstallLocation)'} [${installed.hive}]`)
  } else {
    console.log('  本机已装      未检测到（HKCU/HKLM 都没有 MTNode 卸载项）')
  }
  console.log(`  预期目标目录  ${expectedDir}`)

  const installArgs = ['/S', '/currentuser']
  if (DIR_OPT) installArgs.push(`/D=${expectedDir}`) // NSIS 要求 /D 是最后一个参数且不带引号
  console.log(`  执行          "${installerPath}" ${installArgs.join(' ')}`)

  if (DRY_RUN) {
    console.log('  （--dry-run：只打印命令，未真正安装）')
    return { dryRun: true, command: `"${installerPath}" ${installArgs.join(' ')}`, expectedDir }
  }

  // 守卫 1：本机已装 → 静默安装会被 customInit 引到既有目录，等于替换用户的安装
  if (installed && !UPGRADE) {
    console.log('\n  已中止：本机存在既有安装，installer.nsh 的 customInit 会沿用它的 InstallLocation，')
    console.log('  静默安装将直接覆盖那份安装。确实要量「覆盖安装」耗时，请显式加 --upgrade。')
    return null
  }
  // 守卫 2：目标目录里已经有同样的 exe，也视为覆盖
  if (hasExe(expectedDir) && !UPGRADE) {
    console.log(`\n  已中止：${expectedDir} 已存在 MTNodeAIO.exe；覆盖安装请显式加 --upgrade。`)
    return null
  }

  const preExisting = hasExe(expectedDir)
  const t = await spawnTimed(installerPath, installArgs, TIMEOUT_SEC * 1000)
  if (t.error) {
    console.log(`\n  安装进程启动失败：${t.error.message}`)
    return null
  }
  const installSeconds = t.ms / 1000
  if (t.killed) console.log(`\n  安装超时（>${TIMEOUT_SEC}s），已终止进程；下面的数字不可信。`)

  // NSIS 静默安装可能把落盘交给子进程，进程退出后再等文件出现，等出来的时间单独报
  const waitMs = await waitFor(() => hasExe(expectedDir), 30000)
  const postWaitSeconds = waitMs > 0 ? waitMs / 1000 : 0

  // 回读实际落点：/D 不一定生效（customInit 会按注册表 / 默认目录改写 $INSTDIR）
  const after = findInstalled()
  const actualDir = hasExe(expectedDir)
    ? expectedDir
    : (after?.installLocation && hasExe(after.installLocation) ? after.installLocation : '')
  const mismatch = Boolean(actualDir) && path.resolve(actualDir) !== expectedDir

  if (!actualDir) {
    console.log('\n  安装进程已返回，但没在预期目录找到 MTNodeAIO.exe —— 本次计时结论不可用。')
    console.log(`  请检查：${expectedDir}`)
    return { installSeconds, mismatch: true, actualDir: '', installed: null }
  }
  if (mismatch) console.log(`\n  注意：文件实际落在 ${actualDir}（与预期不同，/D 未生效）。`)

  const footprint = scanTree(actualDir)
  const filesPerSec = installSeconds > 0 ? footprint.files / installSeconds : 0
  console.log(`\n  安装耗时      ${installSeconds.toFixed(1)} s${postWaitSeconds ? `（进程返回，+${postWaitSeconds.toFixed(1)}s 等落盘）` : ''}`)
  console.log(`  落盘量        ${fmtNum(footprint.files)} 个文件 / ${fmtBytes(footprint.bytes)}  →  ${filesPerSec.toFixed(0)} 文件/秒`)

  const result = {
    command: `"${installerPath}" ${installArgs.join(' ')}`,
    expectedDir,
    actualDir,
    mismatch,
    installSeconds: Number(installSeconds.toFixed(2)),
    postWaitSeconds: Number(postWaitSeconds.toFixed(2)),
    installed: { files: footprint.files, bytes: footprint.bytes },
    filesPerSecond: Number(filesPerSec.toFixed(1)),
    preExisting,
    uninstallSeconds: null,
    uninstallCleanupSeconds: null,
    removed: false,
  }

  if (KEEP) {
    console.log('  （--keep：保留已经装好的目录，未卸载）')
    return result
  }

  // 卸载还原本机
  const quiet = after?.quietUninstall ? splitCmd(after.quietUninstall) : []
  const uninstallerExe = quiet.length ? quiet[0] : findUninstaller(actualDir)
  if (!uninstallerExe) {
    console.log('  卸载：找不到卸载程序，未能还原（请手动清理）')
    return result
  }
  const uArgs = quiet.length ? quiet.slice(1) : ['/currentuser', '/S']
  console.log(`  卸载          "${uninstallerExe}" ${uArgs.join(' ')}`)
  const u = await spawnTimed(uninstallerExe, uArgs, TIMEOUT_SEC * 1000)
  result.uninstallSeconds = Number((u.ms / 1000).toFixed(2))
  // NSIS 卸载器会把自己复制到临时目录再删；进程返回只是开始，清完要再等
  const cleanupMs = await waitFor(() => !hasExe(actualDir), 120000)
  result.uninstallCleanupSeconds = cleanupMs >= 0 ? Number((cleanupMs / 1000).toFixed(2)) : null
  result.removed = !hasExe(actualDir)
  console.log(
    `  卸载耗时      ${result.uninstallSeconds.toFixed(1)} s（进程返回）` +
    `，目录清理 ${result.removed ? `${result.uninstallCleanupSeconds ?? '?'} s 完成` : '未完成（请检查）'}`,
  )
  return result
}

// ---------- 主流程 ----------

async function main() {
  const version = readVersion()
  console.log('MTNode 安装成本基线与对比（只读测量）')
  console.log(`  项目          ${ROOT}`)
  console.log(`  version       ${version || '(未知)'}`)
  console.log(`  时间          ${new Date().toISOString()}`)

  // 1) 应用目录
  let app = null
  section('应用目录（安装阶段要写盘的量）')
  if (fs.existsSync(APP_DIR) && fs.statSync(APP_DIR).isDirectory()) {
    app = scanTree(APP_DIR)
    console.log(`  ${APP_DIR}`)
    console.log(`  合计          ${fmtNum(app.files)} 个文件 / ${fmtBytes(app.bytes)}`)
    if (app.largest) console.log(`  最大文件      ${fmtBytes(app.largest.bytes)}  ${path.relative(APP_DIR, app.largest.path)}`)

    console.log('\n  顶层分解（按体积）：')
    const rows = app.top.slice(0, TOP_N).map((r) => [
      r.name,
      fmtNum(r.files),
      `${MB(r.bytes).toFixed(1)} MB`,
      `${((r.bytes / (app.bytes || 1)) * 100).toFixed(1)}%`,
    ])
    printTable(['目录', '文件数', '体积', '占比'], rows)

    const focusRows = FOCUS
      .filter((rel) => fs.existsSync(path.join(APP_DIR, rel)))
      .map((rel) => {
        const s = scanTree(path.join(APP_DIR, rel))
        return [rel, fmtNum(s.files), `${MB(s.bytes).toFixed(1)} MB`, `${((s.files / (app.files || 1)) * 100).toFixed(1)}%`]
      })
    if (focusRows.length) {
      console.log('\n  关注路径：')
      printTable(['路径', '文件数', '体积', '占文件数'], focusRows)
    }
  } else {
    console.log(`  未找到 ${APP_DIR}`)
    console.log('  先打包（npm run dist）或用 --app=<目录> 指定一棵已解包的目录。')
  }

  // 2) 安装包
  section('安装包（用户要下载的量）')
  const installerPath = findInstaller(version)
  let installer = null
  if (!installerPath) {
    console.log('  未找到安装包：dist/MTNodeAIO-Setup-*.exe')
  } else {
    const st = fs.statSync(installerPath)
    const blockmapPath = `${installerPath}.blockmap`
    const bm = fs.existsSync(blockmapPath) ? fs.statSync(blockmapPath) : null
    const pkgVersion = /Setup-(.+)\.exe$/i.exec(path.basename(installerPath))?.[1] || ''
    installer = {
      path: installerPath,
      version: pkgVersion,
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      blockmapBytes: bm ? bm.size : null,
    }
    console.log(`  ${path.basename(installerPath)}  ${fmtBytes(st.size)}  (${fmtNum(st.size)} B)`)
    console.log(`  版本          ${pkgVersion || '(未知)'}${version && pkgVersion !== version ? `  ← 与 version=${version} 不一致（dist 是旧包）` : ''}`)
    if (bm) console.log(`  .blockmap     ${fmtBytes(bm.size)}（差分下载的索引，必须随包保留）`)
    if (app) {
      console.log(`  压缩比        ${((1 - st.size / (app.bytes || 1)) * 100).toFixed(1)}% 压掉`)
    }
  }

  // 3) 安装计时
  let install = null
  if (DO_INSTALL) {
    if (!installerPath) {
      console.log('\n--install 需要先有安装包，已跳过。')
    } else {
      install = await runInstallBench(installerPath, version)
    }
  } else {
    section('安装计时')
    console.log('  未运行（默认只统计）。要量真实安装耗时加 --install，装完会静默卸载还原本机。')
  }

  const result = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    version,
    app: app
      ? {
        dir: app.dir,
        files: app.files,
        bytes: app.bytes,
        top: app.top.map((r) => ({ name: r.name, files: r.files, bytes: r.bytes })),
        largest: app.largest ? { path: path.relative(APP_DIR, app.largest.path), bytes: app.largest.bytes } : null,
      }
      : null,
    installer,
    install,
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    section('落盘')
    console.log(`  已写入 ${JSON_OUT}`)
    console.log('  下一次用 --baseline=<这个文件> 就能看到差值，别靠印象判断快慢。')
  }

  if (BASELINE) {
    section(`与基线对比  ${BASELINE}`)
    if (!fs.existsSync(BASELINE)) {
      console.log('  基线文件不存在，无对比。')
    } else {
      let base = null
      try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch (err) {
        console.log(`  基线读不了：${err.message}`)
      }
      if (base) {
        console.log(`  基线生成于 ${base.generatedAt || '(未知)'}${base.version ? ` · version=${base.version}` : ''}`)
        const rows = []
        const push = (label, now, prev, fmt) => {
          if (now == null || prev == null) return
          rows.push([label, fmt(prev), fmt(now), `${pctStr(now, prev)}`])
        }
        push('应用目录文件数', result.app?.files, base.app?.files, fmtNum)
        push('应用目录体积', result.app?.bytes, base.app?.bytes, fmtBytes)
        push('安装包体积', result.installer?.bytes, base.installer?.bytes, fmtBytes)
        push('静默安装耗时(s)', result.install?.installSeconds, base.install?.installSeconds, (v) => v.toFixed(1))
        if (rows.length) {
          printTable(['指标', '基线', '本次', '变化'], rows)
          const df = result.app && base.app ? signedNum(result.app.files, base.app.files) : ''
          const db = result.app && base.app ? `${signedNum(result.app.bytes, base.app.bytes)} B` : ''
          if (df || db) console.log(`\n  文件数变化 ${df}，体积变化 ${db}`)
        } else {
          console.log('  两份记录没有可比的字段。')
        }
      }
    }
  }

  // 只读模式下的自证：没有写任何东西到系统里
  if (!DO_INSTALL || DRY_RUN) console.log('\n（只读统计，未安装、未修改本机任何状态）')
  return 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
