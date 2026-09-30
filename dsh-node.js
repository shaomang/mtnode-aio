// dsh 运行时的 Node 选择器 —— 真 Node 解析 + 托管 Node 下载安装。
//
// 为什么需要它（2026-09-30 实测）：dsh 0.2 的内核在 boot 阶段要 `node-addon-require-builtin`
// 去 hook ESM 内部模块，该原生插件**只认它编译过的 Electron 版本**（实测回
// `unsupported Electron runtime fingerprint: Node 22.22.1, V8 14.2.231.22-electron.0
// (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)`），而 MTNode 是 Electron 39
// —— 于是打包版网关每次 run 都在 host preparation 阶段硬失败，界面表现为
// 「dsh 网关已退出」/运行时立刻消失。真 Node（≥22.19）走的是运行时探测分支，不受该表约束。
//
// 又因为 SDK 客户端把运行时子进程写死成 `command: process.execPath`
// （见 @deepseek-ai/dsh-sdk-client resolveDshLaunch），**网关自己必须跑在真 Node 上**，
// 否则 process.execPath 仍是 Electron，运行时照旧被拒。
//
// 所以这里的口径是：
//   1. 先在数据目录里找「托管 Node」（<dataDir>/node-runtime/node.exe，由本模块装）；
//   2. 再找本机已装的 Node（env 白名单目录，含 nvm/volta/fnm/scoop/choco/PATH）；
//   3. 都找不到 → 回退 Electron 自带 Node（老行为，0.2 下必错）并**后台自动下载托管 Node**，
//      装好后下次拉起网关即自愈（见 dsh/main-dsh.js）。
// 一切候选都要**真跑一次版本探针**才算数：能跑到、不是 Electron、Node ≥ 22.19。

'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const zlib = require('zlib')

/** dsh 0.2 的运行时的最低 Node（见 dsh/DESIGN.md「版本锁定原则」） */
const NODE_MIN_VERSION = '22.19.0'
/** 托管安装的 Node 版本：与 Electron 39 内置的那个一致，行为可预期 */
const MANAGED_NODE_VERSION = '22.22.1'
/** 托管目录名（在数据目录下，绝不进应用目录） */
const MANAGED_DIR = 'node-runtime'
/** 官方 zip 约 30MB，留足余量后仍小于此值才落盘 */
const MAX_ZIP_BYTES = 160 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 180000

/* ── 版本探针 ─────────────────────────────────────────────────────────── */

const probeCache = new Map()

/** 探针脚本：自报 node / electron 版本，供「Electron 冒充 Node」的分辨 */
const PROBE_SCRIPT = 'JSON.stringify({node:process.versions.node,electron:process.versions.electron||""})'

function versionAtLeast(have, want) {
  const a = String(have || '').split('.').map((n) => parseInt(n, 10) || 0)
  const b = String(want || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * 真跑一次候选可执行文件，回报它到底是什么（Node / Electron / 版本）。
 * 关键点：一律带 ELECTRON_RUN_AS_NODE=1 —— 这样 Electron 二进制的 -p 不会弹窗，
 * 而它此时仍会自报 `process.versions.electron`，正是我们要的分辨依据。
 * @param {string} bin 候选可执行文件绝对路径
 * @param {{fresh?:boolean, script?:string}} [opts] script = 覆盖探针脚本（只给测试用）
 * @returns {{ok:boolean, version?:string, electron?:string, reason?:string, error?:string}}
 */
function probeNodeBin(bin, opts) {
  const o = opts || {}
  const script = o.script || PROBE_SCRIPT
  const key = String(bin || '') + (o.script ? '\u0000' + script : '')
  if (!bin) return { ok: false, reason: 'empty' }
  if (o.fresh) probeCache.delete(key)
  const hit = probeCache.get(key)
  if (hit) return hit
  let out
  try {
    if (!fs.existsSync(bin)) {
      out = { ok: false, reason: 'missing' }
    } else {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      /* 用户环境里的 NODE_OPTIONS 会污染运行时的启动参数，探针与真跑都一律清掉 */
      delete env.NODE_OPTIONS
      const r = spawnSync(bin, ['-p', script], { encoding: 'utf8', timeout: 10000, windowsHide: true, env })
      if (r.error) out = { ok: false, reason: 'spawn-failed', error: r.error.message }
      else if (r.status !== 0) out = { ok: false, reason: 'exit-' + r.status, error: String(r.stderr || '').slice(0, 200) }
      else {
        let info = null
        try { info = JSON.parse(String(r.stdout || '').trim()) } catch { /* 不是 JSON：判为不可用 */ }
        if (!info || !info.node) out = { ok: false, reason: 'unreadable' }
        else if (info.electron) out = { ok: false, reason: 'electron', electron: String(info.electron), version: String(info.node) }
        else if (!versionAtLeast(info.node, NODE_MIN_VERSION)) out = { ok: false, reason: 'too-old', version: String(info.node) }
        else out = { ok: true, version: String(info.node) }
      }
    }
  } catch (e) {
    out = { ok: false, reason: 'probe-failed', error: (e && e.message) || String(e) }
  }
  probeCache.set(key, out)
  return out
}

/* ── 候选清单 ─────────────────────────────────────────────────────────── */

const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node'

function readdirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

/** 扫一层版本目录（nvm / fnm 那种 `v22.22.1/node.exe` 布局） */
function versionDirBins(root, suffix) {
  const out = []
  for (const ent of readdirSafe(root)) {
    if (!ent.isDirectory()) continue
    out.push(path.join(root, ent.name, ...suffix))
  }
  return out
}

/**
 * 本机已装 Node 的候选路径（**只给路径，可用与否由探针判定**）。
 * 顺序＝可信度：env 覆盖 → 托管 → PATH → 各版本管理器 / 包管理器目录。
 * @param {{dataDir?:string, env?:Record<string,string>}} opts
 * @returns {Array<{bin:string, source:string}>}
 */
function nodeCandidates(opts) {
  const o = opts || {}
  const env = o.env || process.env
  const out = []
  const seen = new Set()
  const push = (bin, source) => {
    if (!bin) return
    const key = process.platform === 'win32' ? String(bin).toLowerCase() : String(bin)
    if (seen.has(key)) return   /* 同一个二进制只试一次（PATH 与版本管理器目录常常重复） */
    seen.add(key)
    out.push({ bin: String(bin), source })
  }

  /* 1. 显式覆盖（诊断 / 企业内网自备 Node 的出口） */
  if (env.MTNODE_NODE_BIN) push(String(env.MTNODE_NODE_BIN), 'env:MTNODE_NODE_BIN')
  /* 2. 托管 Node（我们装的，版本确定） */
  if (o.dataDir) push(path.join(String(o.dataDir), MANAGED_DIR, NODE_EXE), 'managed')
  /* 3. PATH */
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    const d = String(dir || '').trim().replace(/^"+|"+$/g, '')
    if (!d) continue
    push(path.join(d, NODE_EXE), 'path')
  }
  /* 4. 常见安装位置（安装器不一定进 PATH） */
  const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA || ''
  const appData = env.APPDATA || ''
  const home = env.USERPROFILE || env.HOME || ''
  const programData = env.ProgramData || 'C:\\ProgramData'
  push(path.join(pf, 'nodejs', NODE_EXE), 'program-files')
  push(path.join(pf86, 'nodejs', NODE_EXE), 'program-files-x86')
  if (local) push(path.join(local, 'Programs', 'nodejs', NODE_EXE), 'local-programs')
  /* nvm-windows：NVM_HOME 下逐个版本目录，NVM_SYMLINK 是指向当前版本的链接 */
  if (env.NVM_HOME) for (const bin of versionDirBins(env.NVM_HOME, [NODE_EXE])) push(bin, 'nvm')
  if (env.NVM_SYMLINK) push(path.join(env.NVM_SYMLINK, NODE_EXE), 'nvm-symlink')
  if (appData) push(path.join(appData, 'nvm', 'nodejs', NODE_EXE), 'nvm-appdata')
  /* fnm / volta / scoop / choco */
  if (appData) for (const bin of versionDirBins(path.join(appData, 'fnm', 'node-versions'), ['installation', NODE_EXE])) push(bin, 'fnm')
  if (local) push(path.join(local, 'Volta', 'bin', NODE_EXE), 'volta')
  if (home) push(path.join(home, 'scoop', 'apps', 'nodejs', 'current', NODE_EXE), 'scoop')
  push(path.join(programData, 'chocolatey', 'bin', NODE_EXE), 'chocolatey')
  return out
}

/* ── 解析（带进程内缓存） ──────────────────────────────────────────────── */

const resolvedByDir = new Map()

/**
 * 选一个真 Node（≥22.19）拉起 dsh 网关；找不到就回退 Electron 自带 Node。
 * @param {{dataDir?:string, log?:(m:string)=>void, env?:Record<string,string>, refresh?:boolean}} opts
 * @returns {{bin:string, source:string, version:string, electron:boolean, fallback:boolean, rejected:Array}}
 */
function resolveDshNode(opts) {
  const o = opts || {}
  const log = o.log || (() => {})
  const key = String(o.dataDir || '')
  if (!o.refresh && !o.env && resolvedByDir.has(key)) return resolvedByDir.get(key)
  const rejected = []
  for (const c of nodeCandidates(o)) {
    const r = probeNodeBin(c.bin)
    if (r.ok) {
      const info = { bin: c.bin, source: c.source, version: r.version, electron: false, fallback: false, rejected }
      resolvedByDir.set(key, info)
      log(`dsh node: ${c.bin} (Node ${r.version}, ${c.source})`)
      return info
    }
    /* Electron 自带的 Node 是环境噪声（PATH 里就有），不必逐条记 */
    if (r.reason !== 'missing' && r.reason !== 'electron') {
      rejected.push({ bin: c.bin, source: c.source, reason: r.reason, version: r.version })
    }
  }
  const fallback = {
    bin: process.execPath,
    source: 'electron-fallback',
    version: process.versions.node,
    electron: true,
    fallback: true,
    rejected,
  }
  log('dsh node: 本机未找到可用的真 Node（≥' + NODE_MIN_VERSION + '），暂回退 Electron 自带 Node'
    + '(dsh 0.2 会拒绝它，见 dsh/DESIGN.md「Node 运行时」)')
  resolvedByDir.set(key, fallback)
  return fallback
}

function resetDshNodeCache() { resolvedByDir.clear() }

/** 托管 Node 的现状（给自检 / UI 用） */
function managedNodeStatus(dataDir) {
  const dir = path.join(String(dataDir || ''), MANAGED_DIR)
  const bin = path.join(dir, NODE_EXE)
  const probe = fs.existsSync(bin) ? probeNodeBin(bin, { fresh: true }) : { ok: false, reason: 'missing' }
  let meta = null
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'node-runtime.json'), 'utf8')) } catch { /* 没装过 */ }
  return { dir, bin, installed: !!probe.ok, version: probe.ok ? probe.version : '', meta }
}

/* ── 下载 + 解压（零依赖） ─────────────────────────────────────────────── */

function httpGetBuffer(url, onProgress, redirects) {
  const left = redirects === undefined ? 5 : redirects
  return new Promise((resolve, reject) => {
    let lib
    try { lib = new URL(url).protocol === 'https:' ? https : http } catch (e) { reject(e); return }
    const req = lib.get(url, { headers: { 'User-Agent': 'MTNodeAIO-node-runtime', Accept: '*/*' }, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (left <= 0) { reject(new Error('too-many-redirects')); return }
        resolve(httpGetBuffer(new URL(res.headers.location, url).href, onProgress, left - 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const total = Number(res.headers['content-length']) || 0
      if (total > MAX_ZIP_BYTES) { res.resume(); reject(new Error('too-large')); return }
      const chunks = []
      let got = 0
      res.on('data', (c) => {
        got += c.length
        if (got > MAX_ZIP_BYTES) { req.destroy(); reject(new Error('too-large')); return }
        chunks.push(c)
        if (onProgress) { try { onProgress(got, total) } catch { /* 进度回调不参与成败 */ } }
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

/** 找 zip 的中央目录结束记录（EOCD）。local header 的尺寸字段可能被数据描述符清空，
 *  所以解压一律走中央目录（Node 官方 zip 也吃这一套）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 把 zip buffer 解到 destDir（只认 store / deflate，拒绝越界路径）。
 * @param {Buffer} buf
 * @param {string} destDir
 * @returns {number} 写出的文件数
 */
function extractZipBuffer(buf, destDir) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('zip: EOCD not found')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  let files = 0
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/')
    off += 46 + nameLen + extraLen + commentLen
    if (!name || name.endsWith('/')) continue
    const norm = name.replace(/^\/+/, '')
    if (norm.split('/').includes('..')) continue
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: bad local header for ' + name)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const end = start + compSize
    if (end > buf.length) throw new Error('zip: truncated entry ' + name)
    const compressed = buf.slice(start, end)
    let raw
    if (method === 0) raw = compressed
    else if (method === 8) raw = zlib.inflateRawSync(compressed)
    else throw new Error('zip: unsupported method ' + method + ' (' + name + ')')
    const outPath = path.join(destDir, ...norm.split('/'))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, raw)
    files++
  }
  return files
}

function managedDownloadUrls(version, arch) {
  const tag = 'v' + version
  const file = `node-${tag}-win-${arch}.zip`
  return [
    `https://registry.npmmirror.com/-/binary/node/${tag}/${file}`,
    `https://npmmirror.com/mirrors/node/${tag}/${file}`,
    `https://nodejs.org/dist/${tag}/${file}`,
  ]
}

/**
 * 下载并安装托管 Node 到 <dataDir>/node-runtime。
 * @param {{dataDir:string, log?:(m:string)=>void, version?:string, onProgress?:(p:{got:number,total:number})=>void,
 *          zipPath?:string, urls?:string[]}} opts zipPath = 用本机已有的 zip（离线 / 测试）
 * @returns {Promise<{ok:boolean, bin?:string, version?:string, error?:string}>}
 */
async function installManagedNode(opts) {
  const o = opts || {}
  const log = o.log || (() => {})
  const dataDir = String(o.dataDir || '')
  if (!dataDir) return { ok: false, error: 'no-data-dir' }
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' }
  const version = o.version || MANAGED_NODE_VERSION
  const dir = path.join(dataDir, MANAGED_DIR)
  const bin = path.join(dir, NODE_EXE)

  const have = probeNodeBin(bin, { fresh: true })
  if (have.ok) return { ok: true, bin, version: have.version, already: true }

  let buf = null
  let from = ''
  if (o.zipPath) {
    buf = fs.readFileSync(o.zipPath)
    from = 'file:' + o.zipPath
  } else {
    if (process.env.MTNODE_NO_NODE_DOWNLOAD === '1') return { ok: false, error: 'disabled' }
    const urls = o.urls || managedDownloadUrls(version, process.arch === 'arm64' ? 'arm64' : 'x64')
    const errors = []
    for (const url of urls) {
      try {
        log('dsh node: 下载 ' + url)
        buf = await httpGetBuffer(url, (got, total) => {
          if (o.onProgress) o.onProgress({ got, total })
        })
        from = url
        break
      } catch (e) {
        errors.push(url + ' → ' + ((e && e.message) || String(e)))
      }
    }
    if (!buf) return { ok: false, error: 'download-failed: ' + errors.join(' | ') }
  }

  const tmp = path.join(dataDir, MANAGED_DIR + '.tmp')
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    const files = extractZipBuffer(buf, tmp)
    if (!files) throw new Error('zip: empty')
    /* 官方 zip 顶层是 node-vX-win-x64/，把它整层内容搬到托管目录 */
    let root = tmp
    const entries = fs.readdirSync(tmp, { withFileTypes: true })
    if (entries.length === 1 && entries[0].isDirectory()) root = path.join(tmp, entries[0].name)
    if (!fs.existsSync(path.join(root, NODE_EXE))) throw new Error('zip: ' + NODE_EXE + ' missing')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(root, dir)
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, error: (e && e.message) || String(e) }
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  const probe = probeNodeBin(bin, { fresh: true })
  if (!probe.ok) return { ok: false, error: 'installed-but-unusable: ' + probe.reason }
  try {
    fs.writeFileSync(path.join(dir, 'node-runtime.json'), JSON.stringify({
      version: probe.version, from, installedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
  } catch { /* 备忘文件写不了不影响可用性 */ }
  log('dsh node: 托管 Node ' + probe.version + ' 已就绪 → ' + bin)
  return { ok: true, bin, version: probe.version }
}

/* ── 报错翻译（截获 dsh 的原始报错，给出可执行的下一步） ────────────────── */

const RUNTIME_REJECT = /unsupported Electron runtime fingerprint|node-addon-require-builtin unsupported|host preparation failed/i

/**
 * dsh 运行时被 Electron 指纹拒绝时，把 SDK 那段 stderr 尾巴换成用户能懂、能修的话。
 * @param {string} message 网关透传的原始 error message
 * @param {{fallback?:boolean, installing?:boolean, installed?:boolean, version?:string, bin?:string, error?:string}} state
 * @returns {string|null} null = 不是这个错，原样透传
 */
function translateRuntimeReject(message, state) {
  const msg = String(message || '')
  if (!RUNTIME_REJECT.test(msg)) return null
  const s = state || {}
  let tail
  if (!s.fallback && !s.installing) {
    tail = '请重试本轮；若仍失败，把 dsh.log 里的这行发给开发者。'
  } else if (s.installing) {
    tail = '正在后台下载本机 Node，装好后重试本轮即可。'
  } else if (s.installed) {
    tail = '本机 Node 已就绪（' + (s.version || '') + '），重试本轮即可。'
  } else {
    tail = '自动安装未成功' + (s.error ? '（' + String(s.error).slice(0, 120) + '）' : '')
      + '；可设置环境变量 MTNODE_NODE_BIN 指向本机 Node 22+ 后重启 MTNode。'
  }
  return 'dsh 运行时需要本机 Node ≥' + NODE_MIN_VERSION + '（dsh 0.2 的内核不接受 Electron 自带的 Node）：' + tail
}

module.exports = {
  NODE_MIN_VERSION,
  MANAGED_NODE_VERSION,
  MANAGED_DIR,
  nodeCandidates,
  probeNodeBin,
  resolveDshNode,
  resetDshNodeCache,
  managedNodeStatus,
  installManagedNode,
  extractZipBuffer,
  translateRuntimeReject,
  versionAtLeast,
}
