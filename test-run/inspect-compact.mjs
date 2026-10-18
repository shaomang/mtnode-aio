/* 临时排查脚本（本会话用后即弃）：多帧 zstd 会话日志 → 逐行 JSON 检索 */
import zlib from 'node:zlib'
import fs from 'node:fs'

const FLUSH = zlib.constants ? zlib.constants.ZSTD_e_flush ?? 1 : 1

/* 与 scripts/audit-token-usage.mjs 同款：会话 zstd 是多帧追加，必须逐帧解 */
const ZSTD_MAGIC = 4247762216
function scanZstdFrames(buf) {
  const frames = []
  let o = 0
  let torn = 0
  while (o + 4 <= buf.length) {
    const start = o
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) { torn = buf.length; break }
    o += 4
    const d = buf.readUInt8(o); o += 1
    if ((d & 24) !== 0) { torn = buf.length; break }
    const single = (d & 32) !== 0
    const checksum = (d & 4) !== 0
    const dictFlag = d & 3
    const sizeFlag = d >>> 6
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag
    o += (single ? 0 : 1) + dictBytes + contentBytes
    let complete = o <= buf.length
    while (complete) {
      if (buf.length - o < 3) { complete = false; break }
      const bh = buf.readUIntLE(o, 3); o += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 3
      const size = bh >>> 3
      if (type === 3) { complete = false; o = buf.length; break }
      o += type === 1 ? 1 : size
      if (buf.length - o < 0) { complete = false; break }
      if (last) break
    }
    if (!complete) { torn = start; break }
    if (checksum) {
      if (buf.length - o < 4) { torn = start; break }
      o += 4
    }
    frames.push({ start, end: o })
  }
  return { frames, torn }
}

function decodeFrame(bytes) {
  try { return zlib.zstdDecompressSync(bytes).toString('utf8') } catch {
    try { return zlib.zstdDecompressSync(bytes, { finishFlush: FLUSH }).toString('utf8') } catch { return '' }
  }
}

const file = process.argv[2]
const buf = fs.readFileSync(file)
const { frames } = scanZstdFrames(buf)
let text = ''
for (const f of frames) text += decodeFrame(buf.subarray(f.start, f.end))
console.log('frames =', frames.length, ' bytes =', text.length)

const recs = []
for (const line of text.split('\n')) {
  if (!line) continue
  try { recs.push(JSON.parse(line)) } catch {}
}
console.log('records =', recs.length)
const kinds = new Map()
for (const r of recs) {
  const k = r.type || r.kind || '?'
  kinds.set(k, (kinds.get(k) || 0) + 1)
}
console.log('类型:', [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x.join('×')).join('  '))

/* request/header 上的路由与 maxTokens（压缩触发线的两个关键输入） */
for (const r of recs) {
  const s = JSON.stringify(r)
  if (/request\/header|"config":\{/.test(s) && /provider|model/.test(s)) {
    const m = s.match(/"provider":"[^"]+","model":"[^"]+"[^}]*/)
    if (m) { console.log('route:', m[0].slice(0, 200)); break }
  }
}
/* 压缩 / 溢出相关事件 */
const hits = text.match(/compaction[^,"]{0,80}/g) || []
console.log('compaction 提及:', [...new Set(hits)].slice(0, 10).join(' | '))
const mt = new Set()
let m
const re = /"maxTokens":(\d+)/g
while ((m = re.exec(text))) mt.add(m[1])
console.log('maxTokens 取值:', [...mt].join(', '))
const re2 = /"contextWindow":(\d+)/g
const cw = new Set()
while ((m = re2.exec(text))) cw.add(m[1])
console.log('contextWindow 取值:', [...cw].join(', '))
