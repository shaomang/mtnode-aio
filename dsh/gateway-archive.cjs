// 网关单文件归档（.mtgw）：打包时由 dsh/after-pack.cjs 写，运行期由 dsh-node.js 解
// 到用户数据目录。两边共用本文件，格式只有一份定义。
//
// 为什么自己写格式（而不是 asar / 7z）：
//   ① 网关必须由**真 Node**（≥22.19）拉起 —— Node 的 require / ESM 解析读不了 asar
//      虚拟路径，所以 asar 那条路对网关根本不通；
//   ② 原生 .node 与动态 require（sharp/@img、sherpa-onnx）只要经过打包器的静态分析
//      就可能被改坏；
//   ③ 这里只做「把一串真实文件按原样串成一个文件」，运行期**原样解回成真实目录树**：
//      解包后的路径与开发树逐字节相同，Node 的模块解析、原生模块、动态 require 全都
//      不参与分析 —— 上面三条风险一个都不存在。
// 目标本身不是省体积而是**省文件数**（16,028 个文件 → 1 个）：安装阶段每个文件都要过
// 一次安全软件实时扫描，文件数才是安装耗时的第一杠杆。所以正文一律不压缩（压缩由 NSIS
// 在安装包里做一次，运行期解包不再多花一次解压 CPU）。
//
// 布局（全部小端）：
//   [0..7]      魔数 "MTNGWARC"
//   [8..11]     uint32 头部长度
//   [12..]      头部 JSON（UTF-8）：{ v, buildId, createdAt, dirs:[rel], files:[[rel, off, size]] }
//   [12+头长..] 各文件原始字节，按 files[] 的 off 顺序紧密排列
//
// 两个随包文件（都在 resources/dsh 下）：
//   gateway-tree.mtgw    归档正文（唯一的大文件）
//   gateway-tree.json    旁挂索引：{v, buildId, files, bytes, createdAt, archive}
// 旁挂索引的意义：运行期快路径只读这 200 字节就能判断「这个版本解过没有」，不必为了
// 拿 buildId 去读 1MB 头部。

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

/** 归档魔数（8 字节，定长） */
const MAGIC = Buffer.from('MTNGWARC', 'ascii')
const FORMAT_VERSION = 1
/** 随包归档文件名（resources/dsh/ 下） */
const ARCHIVE_NAME = 'gateway-tree.mtgw'
/** 随包旁挂索引文件名（resources/dsh/ 下） */
const SIDECAR_NAME = 'gateway-tree.json'
/** 解包完成标记（解包目录内，内容是 JSON） */
const MARKER_NAME = '.unpack-ok'
/** 流式读写块大小 */
const CHUNK_BYTES = 4 * 1024 * 1024

/* ── 路径安全 ─────────────────────────────────────────────────────────── */

/**
 * 归一 + 校验一个归档内相对路径：只认正斜杠分隔的相对路径。
 * 越界（.. / 绝对路径 / 盘符 / 空段之外的空值）一律抛错 —— 解包侧据此拒绝任何
 * 「写到目标目录外面」的条目（归档是随包产物，但读取侧仍按不可信数据处理）。
 * @param {string} rel
 * @returns {string}
 */
function normalizeRel(rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/')
  if (!raw || raw.includes('\u0000')) throw new Error('archive: 非法条目名 ' + JSON.stringify(rel))
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) throw new Error('archive: 条目名必须是相对路径 ' + JSON.stringify(rel))
  const segs = raw.split('/').filter((s) => s !== '')
  if (!segs.length) throw new Error('archive: 空条目名 ' + JSON.stringify(rel))
  for (const s of segs) {
    if (s === '.' || s === '..') throw new Error('archive: 条目名含越界段 ' + JSON.stringify(rel))
  }
  return segs.join('/')
}

/** 把归档内相对路径落到目标目录下，并再确认一次「没跑出目标目录」。 */
function joinUnder(rootDir, rel) {
  const dst = path.resolve(rootDir, ...normalizeRel(rel).split('/'))
  const base = path.resolve(rootDir)
  if (dst !== base && !dst.startsWith(base + path.sep)) {
    throw new Error('archive: 条目越界 ' + JSON.stringify(rel))
  }
  return dst
}

function writeAll(fd, buf, length) {
  let done = 0
  while (done < length) {
    const n = fs.writeSync(fd, buf, done, length - done)
    if (n <= 0) throw new Error('archive: 写入不足（fd=' + fd + '）')
    done += n
  }
}

/* ── 写（打包侧） ─────────────────────────────────────────────────────── */

/**
 * 建一个归档写入器。所有 add* 都是流式写 body 临时文件，finish() 时才拼出最终文件
 * （头部长度依赖条目表，只能最后写）。
 * @param {string} archivePath 最终归档绝对路径
 */
function createArchiveWriter(archivePath) {
  const out = String(archivePath || '')
  if (!out) throw new Error('archive: 缺输出路径')
  const bodyPath = out + '.body'
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.rmSync(bodyPath, { force: true })
  const bodyFd = fs.openSync(bodyPath, 'w')
  const hash = crypto.createHash('sha256')
  /** @type {Array<[string, number, number]>} */
  const files = []
  const dirs = []
  let offset = 0
  let bytes = 0
  let done = false
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)

  const closeBody = () => {
    try { fs.closeSync(bodyFd) } catch { /* 已关 */ }
  }

  /**
   * 把一段内容流式写进 body，并把它算进 buildId。
   * @param {string} rel 归档内相对路径
   * @param {number} size 字节数
   * @param {number} srcFd 源文件 fd（srcBuf 为空时用）
   * @param {Buffer|null} srcBuf 内存源（addBuffer 用）
   */
  const push = (rel, size, srcFd, srcBuf) => {
    const r = normalizeRel(rel)
    hash.update(r + '\u0000' + size + '\u0000')
    let left = size
    let pos = 0
    while (left > 0) {
      const want = Math.min(CHUNK_BYTES, left)
      if (srcBuf) {
        buf.set(srcBuf.subarray(pos, pos + want), 0)
      } else {
        const n = fs.readSync(srcFd, buf, 0, want, pos)
        if (n !== want) throw new Error('archive: 读取不足 ' + r)
      }
      writeAll(bodyFd, buf, want)
      hash.update(buf.subarray(0, want))
      pos += want
      left -= want
    }
    files.push([r, offset, size])
    offset += size
    bytes += size
  }

  return {
    /** 记一个目录（空目录也要能还原） */
    addDir(rel) {
      if (done) throw new Error('archive: 已收尾')
      const r = normalizeRel(rel)
      dirs.push(r)
      hash.update('d\u0000' + r + '\u0000')
    },
    /** 把一个真实文件原样写进归档 */
    addFile(rel, absPath) {
      if (done) throw new Error('archive: 已收尾')
      const st = fs.statSync(absPath)
      if (!st.isFile()) throw new Error('archive: 不是普通文件 ' + absPath)
      const fd = fs.openSync(absPath, 'r')
      try {
        push(rel, st.size, fd, null)
      } finally {
        try { fs.closeSync(fd) } catch { /* 已关 */ }
      }
    },
    /** 把一个内存块写进归档（cordis.yml 这类需要就地改写的文件） */
    addBuffer(rel, data) {
      if (done) throw new Error('archive: 已收尾')
      const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      push(rel, b.length, -1, b)
    },
    /** 收尾：写最终文件（魔数 + 头 + body），删临时 body，返回统计 */
    finish() {
      if (done) throw new Error('archive: 重复收尾')
      done = true
      closeBody()
      const buildId = hash.digest('hex').slice(0, 16)
      const header = Buffer.from(JSON.stringify({
        v: FORMAT_VERSION,
        buildId,
        createdAt: new Date().toISOString(),
        dirs,
        files,
      }), 'utf8')
      const outFd = fs.openSync(out, 'w')
      try {
        writeAll(outFd, MAGIC, MAGIC.length)
        const len = Buffer.allocUnsafe(4)
        len.writeUInt32LE(header.length, 0)
        writeAll(outFd, len, 4)
        writeAll(outFd, header, header.length)
        const srcFd = fs.openSync(bodyPath, 'r')
        try {
          let left = offset
          let pos = 0
          while (left > 0) {
            const n = fs.readSync(srcFd, buf, 0, Math.min(CHUNK_BYTES, left), pos)
            if (n <= 0) throw new Error('archive: body 读取不足')
            writeAll(outFd, buf, n)
            pos += n
            left -= n
          }
        } finally {
          try { fs.closeSync(srcFd) } catch { /* 已关 */ }
        }
      } finally {
        try { fs.closeSync(outFd) } catch { /* 已关 */ }
        fs.rmSync(bodyPath, { force: true })
      }
      return {
        archivePath: out,
        buildId,
        dirs: dirs.length,
        files: files.length,
        bytes,
        headerBytes: header.length,
        archiveBytes: fs.statSync(out).size,
      }
    },
    /** 失败清理（打包中断时别留半截 body） */
    abort() {
      if (!done) { done = true; closeBody() }
      fs.rmSync(bodyPath, { force: true })
    },
  }
}

/* ── 读头部（运行期解包前先拿到条目表） ───────────────────────────────── */

/**
 * 只读归档头部（不碰正文）。
 * @param {string} archivePath
 * @returns {{v:number, buildId:string, createdAt:string, dirs:string[],
 *            files:Array<[string, number, number]>, headerBytes:number, dataOffset:number}}
 */
function readArchiveHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  try {
    const pre = Buffer.allocUnsafe(12)
    const got = fs.readSync(fd, pre, 0, 12, 0)
    if (got < 12) throw new Error('archive: 文件过短 ' + archivePath)
    if (!pre.subarray(0, 8).equals(MAGIC)) {
      throw new Error('archive: 魔数不匹配（不是 ' + ARCHIVE_NAME + '）: ' + archivePath)
    }
    const headerLen = pre.readUInt32LE(8)
    if (headerLen <= 0 || headerLen > 64 * 1024 * 1024) throw new Error('archive: 头部长度异常 ' + headerLen)
    const headerBuf = Buffer.allocUnsafe(headerLen)
    let read = 0
    while (read < headerLen) {
      const n = fs.readSync(fd, headerBuf, read, headerLen - read, 12 + read)
      if (n <= 0) throw new Error('archive: 头部被截断')
      read += n
    }
    let header = null
    try { header = JSON.parse(headerBuf.toString('utf8')) } catch (e) {
      throw new Error('archive: 头部不是合法 JSON（' + ((e && e.message) || e) + '）')
    }
    if (!header || header.v !== FORMAT_VERSION) throw new Error('archive: 不支持的格式版本 ' + (header && header.v))
    return {
      v: header.v,
      buildId: String(header.buildId || ''),
      createdAt: String(header.createdAt || ''),
      dirs: Array.isArray(header.dirs) ? header.dirs : [],
      files: Array.isArray(header.files) ? header.files : [],
      headerBytes: headerLen,
      dataOffset: 12 + headerLen,
    }
  } finally {
    try { fs.closeSync(fd) } catch { /* 已关 */ }
  }
}

/* ── 解包（运行期） ───────────────────────────────────────────────────── */

/**
 * 把归档解开成一棵真实目录树（逐字节还原，不做任何改写）。
 * @param {string} archivePath
 * @param {string} destDir 目标目录（不存在则创建；已存在则覆盖同名文件）
 * @param {{log?:(m:string)=>void, onProgress?:(p:{files:number, total:number})=>void,
 *          progressEvery?:number}} [opts]
 * @returns {{files:number, bytes:number, dirs:number, buildId:string}}
 */
function extractArchive(archivePath, destDir, opts) {
  const o = opts || {}
  const log = typeof o.log === 'function' ? o.log : () => {}
  const header = readArchiveHeader(archivePath)
  const total = header.files.length
  const step = Math.max(1, Number(o.progressEvery) || 4000)
  fs.mkdirSync(destDir, { recursive: true })
  for (const d of header.dirs) fs.mkdirSync(joinUnder(destDir, d), { recursive: true })

  const srcFd = fs.openSync(archivePath, 'r')
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  let bytes = 0
  try {
    let i = 0
    for (const entry of header.files) {
      if (!Array.isArray(entry) || entry.length < 3) throw new Error('archive: 条目表损坏（第 ' + i + ' 条）')
      const rel = entry[0]
      const off = Number(entry[1]) || 0
      const size = Number(entry[2]) || 0
      const dst = joinUnder(destDir, rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      const dfd = fs.openSync(dst, 'w')
      try {
        let left = size
        let pos = header.dataOffset + off
        while (left > 0) {
          const n = fs.readSync(srcFd, buf, 0, Math.min(CHUNK_BYTES, left), pos)
          if (n <= 0) throw new Error('archive: 正文被截断 ' + rel)
          writeAll(dfd, buf, n)
          pos += n
          left -= n
        }
      } finally {
        try { fs.closeSync(dfd) } catch { /* 已关 */ }
      }
      bytes += size
      i++
      if (o.onProgress) { try { o.onProgress({ files: i, total }) } catch { /* 进度不影响成败 */ } }
      if (i % step === 0 && i < total) log('dsh gateway 解包进度 ' + i + '/' + total)
    }
  } finally {
    try { fs.closeSync(srcFd) } catch { /* 已关 */ }
  }
  return { files: total, bytes, dirs: header.dirs.length, buildId: header.buildId }
}

/* ── 随包旁挂索引 ─────────────────────────────────────────────────────── */

/**
 * 写旁挂索引（与归档同目录）。
 * @param {string} dshDir resources/dsh 目录
 * @param {{buildId:string, files:number, bytes:number, archiveBytes:number}} info
 */
function writeSidecar(dshDir, info) {
  const p = path.join(dshDir, SIDECAR_NAME)
  const body = {
    v: FORMAT_VERSION,
    buildId: info.buildId,
    archive: ARCHIVE_NAME,
    files: info.files,
    bytes: info.bytes,
    archiveBytes: info.archiveBytes,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8')
  return p
}

/**
 * 读旁挂索引并核对归档文件存在。
 * @param {string} dshDir resources/dsh 目录
 * @returns {{archive:string, buildId:string, files:number, bytes:number}|null}
 */
function readSidecar(dshDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dshDir, SIDECAR_NAME), 'utf8'))
    if (!j || j.v !== FORMAT_VERSION || !j.buildId) return null
    const archivePath = path.join(dshDir, String(j.archive || ARCHIVE_NAME))
    if (!fs.existsSync(archivePath)) return null
    return {
      archive: archivePath,
      buildId: String(j.buildId),
      files: Number(j.files) || 0,
      bytes: Number(j.bytes) || 0,
    }
  } catch {
    return null
  }
}

module.exports = {
  MAGIC,
  FORMAT_VERSION,
  ARCHIVE_NAME,
  SIDECAR_NAME,
  MARKER_NAME,
  CHUNK_BYTES,
  normalizeRel,
  createArchiveWriter,
  readArchiveHeader,
  extractArchive,
  writeSidecar,
  readSidecar,
}
