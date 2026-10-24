// 字幕排版 · 单一真源（零依赖 ESM · 谁都能 import）
//
// 为什么单独成文件：同一条排版规则有两个消费者 ——
//   ① dsh 运行时里的 Agent 工具 audio_subtitle（media-plugin.mjs）；
//   ② MTNode 主进程的内置工具「音频转字幕」（根目录 media-subtitle.js，经
//      fn-runtime 的 mtnode.subtitle 桥跑到画布上）。
// 两处若各写一份，改一处必然漂移（时间码 / 断句 / 去句末句号任一处不一致，用户看到
// 的就是两套字幕）。所以纯函数只在这里写一次：
//   · 网关侧按相对路径 import（打包时整棵 dsh/gateway 复制到 resources/dsh/gateway，
//     文件跟着走，见 dsh/after-pack.cjs）；
//   · 主进程侧按 GATEWAY_PATH 的同级绝对路径动态 import（dsh/main-dsh.js 导出的
//     GATEWAY_PATH 就是这份文件的目录）。
//
// 口径（用户共识，改动前先复核）：
//   · 默认单条 ≤ 6 秒；中文字幕 18 字 / 英文字幕 42 字符，按识别文本的 CJK 占比自动选；
//   · 一句话被拆成多条 cue 时，按各条字数占比分配时间轴（不是均分）；
//   · 只去掉句末句号，问号 / 感叹号 / 句中标点全部保留；
//   · 英文按词断，不拆单词；时间码是切片级近似（静音切句），不是逐字对齐。
// 全部是纯函数：不碰进程、不写盘、不读环境，测试可直接断言（见 dsh/smoke-subtitle.mjs
// 与 test/smoke-subtitle-tool.js）。

/* ── 默认值 ──────────────────────────────────────────────────────────────── */

export const SUBTITLE_MAX_SECONDS = 6
export const SUBTITLE_MAX_CHARS_CJK = 18
export const SUBTITLE_MAX_CHARS_LATIN = 42
/* 断句标点：除常规标点外，成对引号的「右半边」（” ’ 」 』）同样可以断句 ——
   否则「‘吞’」这类夹引号的短语会整段超长，被迫按字硬切把引号劈开。
   句末语气符（～ ~ ・）也收：拖长的语气后面就是下一句话，不断会与下一句粘连。 */
export const SUBTITLE_BREAK_PUNCT = '。！？!?；;…，,、：:—～~·"”’』」）)'
/* 中文字幕按字断、英文字幕按词断：CJK 占比超过这条线就按中文字符口径算。 */
export const CJK_RATIO_FOR_CJK = 0.2

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/* ── 通用小工具 ──────────────────────────────────────────────────────────── */

/** 数值参数归一：非数字 / 越界回落到默认值（参数可能来自模型或手填文本框）。 */
export function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export const round3 = (n) => Math.round(Number(n) * 1000) / 1000

/* ── 文本口径 ────────────────────────────────────────────────────────────── */

/** 这段文本是否按中文字幕口径算（CJK 占比超过 20%）。 */
export function isCjkHeavy(text) {
  const chars = Array.from(String(text || '')).filter((c) => !/\s/.test(c))
  if (!chars.length) return false
  const cjk = chars.filter((c) => CJK_RE.test(c)).length
  return cjk / chars.length >= CJK_RATIO_FOR_CJK
}

/** 只去掉句末句号（用户共识：问号 / 感叹号 / 句中标点全部保留）。 */
export function stripFinalPeriod(text) {
  return String(text == null ? '' : text)
    .replace(/[。.．]+$/u, '')
    .trim()
}

/** 按标点在「字符之后」断开，标点留在前一段里 —— 拼回去就是原文。
 *  两点补充（都是为了不把台词切成没法用的碎片）：
 *  ① 连续的同类标点当作一个断点（「……」只断一次，不再多出一个只有「…」的句子）；
 *  ② 纯标点段落（整段没有一个可读字符）不单独成句，而是并回前一段 ——
 *     否则它会占掉一个「句子」，在切分模式下变成对不上语音的 unmatchedScript。 */
export function splitAfterPunctuation(text, marks) {
  const raw = Array.from(String(marks || ''))
  const set = new Set(raw)
  if (!set.size) return [String(text || '').trim()].filter(Boolean)
  /* 成对引号的**左半边**（‘ “ 「 『 ( （）不单独当断点：它后面紧跟的就是引号里的正文，
     在它之后就断会切出「帮你把bug都‘」+「吞’」这种把引号劈开的碎片。
     断点只落在闭合一侧（右引号 』 」 ’ ” ） ），这些标点留给前一段。 */
  const OPENERS = new Set(['‘', '“', '『', '「', '(', '（'])
  for (const o of OPENERS) set.delete(o)
  const out = []
  let buf = ''
  let prevMark = ''
  for (const ch of String(text || '')) {
    const isMark = set.has(ch)
    if (prevMark && !isMark) {
      /* 标点后紧跟正文 → 上一句到这里结束 */
      out.push(buf)
      buf = ch
      prevMark = ''
      continue
    }
    if (isMark && prevMark && prevMark !== ch) {
      /* 换了一种标点 → 上一句到这里结束（不同标点各自断） */
      out.push(buf)
      buf = ch
      prevMark = ch
      continue
    }
    buf += ch
    prevMark = isMark ? ch : ''
  }
  if (buf.trim()) out.push(buf)
  const hasReadable = (s) => /\S/.test(String(s || '').replace(/[\p{P}\p{S}\s]/gu, ''))
  const merged = []
  for (const raw of out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (merged.length && !hasReadable(raw)) {
      /* 纯标点并回前一段：前段末尾的空格丢掉，再接上标点（英文「…… !」不留双空格） */
      merged[merged.length - 1] = merged[merged.length - 1].replace(/\s+$/, '') + raw
    } else merged.push(raw)
  }
  return merged
}

const charWeight = (s) => Math.max(Array.from(String(s || '')).length, 1)

/** 英文按词断、不拆单词（单个单词本身超长时才按字符硬切）。 */
export function splitLatinWords(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const out = []
  let cur = ''
  for (const w of words) {
    const chars = Array.from(w)
    if (chars.length > maxChars) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      for (let i = 0; i < chars.length; i += maxChars) out.push(chars.slice(i, i + maxChars).join(''))
      continue
    }
    const next = cur ? cur + ' ' + w : w
    if (Array.from(next).length <= maxChars) cur = next
    else {
      if (cur) out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 单段超长时的硬切（中文按字、英文按词）。
    中文没有词边界信息可用，靠单字白名单猜「不撕词」既不可靠、又会把行削短 ——
    改成确定性口径：需要切时按 k = ceil(n / maxChars) 均分成 k 份（每份 ≈ n/k 字，
    比「每行顶满 maxChars、最后一行只剩一两个字」更均衡）。 */
export function hardSplit(text, maxChars, latin) {
  const s = String(text || '').trim()
  if (!s) return []
  const chars = Array.from(s)
  if (chars.length <= maxChars) return [s]
  if (latin) return splitLatinWords(s, maxChars).filter(Boolean)
  const k = Math.ceil(chars.length / maxChars)
  return splitTextByCount(s, k, false)
}

/** 把已断好的片段按不超过 maxChars 打包成 cue 的文本。 */
export function packPieces(pieces, maxChars) {
  const out = []
  let cur = ''
  for (const p of pieces) {
    const next = cur ? cur + p : p
    if (Array.from(next).length <= maxChars) cur = next
    else {
      if (cur) out.push(cur)
      cur = p
    }
  }
  if (cur) out.push(cur)
  return out.filter(Boolean)
}

/** 把一段文本按字数占比切成 k 份（英文尽量切在空格上，不撕单词）。 */
export function splitTextByCount(text, k, latin) {
  const s = String(text || '').trim()
  const chars = Array.from(s)
  const n = Math.min(Math.max(1, Math.floor(k)), chars.length)
  if (n <= 1) return [s].filter(Boolean)
  const out = []
  let idx = 0
  for (let i = 0; i < n; i++) {
    const take = Math.max(1, Math.ceil((chars.length - idx) / (n - i)))
    let piece = chars.slice(idx, idx + take).join('')
    idx += take
    if (latin && idx < chars.length) {
      /* 切点落在单词中间就往回找最近的空格，把整个词留给下一段。 */
      const sp = piece.lastIndexOf(' ')
      if (sp > 0) {
        idx -= Array.from(piece.slice(sp + 1)).length
        piece = piece.slice(0, sp)
      }
    }
    const t = piece.trim()
    if (t) out.push(t)
  }
  return out
}

/* ── 原台词（切分模式）：断句 + 单调对齐 ────────────────────────────────── */
//
// 为什么需要：识别总会错字，用户手上有原台词时希望字幕正文**从台词里截取**。
// 但官方 SenseVoice 只回整句文本、没有逐字时间戳，时间边界只能来自静音切句，
// 所以「台词第 n 句 ↔ 语音第几段」必须自己对齐 —— 对齐逻辑也只在这里写一份。

/* 低于这条相似度就不算「同一句」：宁可跳过、把清单交给用户核对，也不硬塞错位字幕。 */
export const SCRIPT_MIN_SIMILARITY = 0.34
/* 一侧最多合并几段（台词一句可能跨 2–3 个静音切句，反之亦然）。 */
export const SCRIPT_MAX_GROUP = 3

/** 对齐只看内容：小写、去掉空白与标点（识别结果常丢标点）。 */
export function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 原台词断句：换行是**强制**断句点，行内再按 breakPunctuation 断（标点留在前一段）。
 * @param {string} text 原台词正文
 * @param {string} [marks] 断句标点集合
 * @returns {string[]}
 */
export function splitScriptSentences(text, marks) {
  const out = []
  const set = marks == null ? SUBTITLE_BREAK_PUNCT : String(marks)
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    for (const part of splitAfterPunctuation(line, set)) {
      const t = part.trim()
      if (t) out.push(t)
    }
  }
  return out
}

const diceOfList = (a, b) => {
  if (!a.length || !b.length) return 0
  const counts = new Map()
  for (const c of a) counts.set(c, (counts.get(c) || 0) + 1)
  let hit = 0
  for (const c of b) {
    const k = counts.get(c)
    if (k) {
      hit++
      counts.set(c, k - 1)
    }
  }
  return (2 * hit) / (a.length + b.length)
}

const bigramsOf = (s) => {
  const c = Array.from(s)
  const out = []
  for (let i = 0; i + 1 < c.length; i++) out.push(c[i] + c[i + 1])
  return out
}

/** 两段文本的相似度（0–1）：字面重合 + 相邻字序各占一半，短句也稳。 */
export function textSimilarity(a, b) {
  const na = String(a == null ? '' : a)
  const nb = String(b == null ? '' : b)
  if (!na || !nb) return 0
  const charScore = diceOfList(Array.from(na), Array.from(nb))
  const biA = bigramsOf(na)
  const biB = bigramsOf(nb)
  const biScore = biA.length && biB.length ? diceOfList(biA, biB) : charScore
  return 0.5 * charScore + 0.5 * biScore
}

/**
 * 台词句 ↔ 语音段做**单调**对齐（不交叉），两侧都允许跳过、允许合并相邻段。
 *
 * @param {string[]} scriptSentences 原台词断好的句子（splitScriptSentences）
 * @param {Array<{start:number,end:number,text:string}>} asrSentences 静音切句 + 识别结果
 * @param {{minSimilarity?:number, maxGroup?:number}} [opts]
 * @returns {{pairs:Array, unmatchedScript:string[], unmatchedAsr:Array}}
 *   pairs: [{ start, end, text, scriptFrom, scriptTo, asrFrom, asrTo, similarity, asrText }]
 *   text 是**原台词里的连续片段**（逐字截取），时间取对齐到的语音段起止。
 */
export function alignScriptToAsr(scriptSentences, asrSentences, opts = {}) {
  const minSim = clampNum(opts.minSimilarity, 0, 1, SCRIPT_MIN_SIMILARITY)
  const maxGroup = Math.round(clampNum(opts.maxGroup, 1, 4, SCRIPT_MAX_GROUP))
  const S = (Array.isArray(scriptSentences) ? scriptSentences : []).map((s) =>
    String(s == null ? '' : s).trim(),
  ).filter(Boolean)
  const A = (Array.isArray(asrSentences) ? asrSentences : [])
    .map((s, i) => ({
      index: i,
      start: Number(s && s.start),
      end: Number(s && s.end),
      text: String((s && s.text) || '').trim(),
    }))
    .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)

  const out = { pairs: [], unmatchedScript: [], unmatchedAsr: [] }
  if (!S.length || !A.length) {
    out.unmatchedScript = S.slice()
    out.unmatchedAsr = A.map((a) => ({ ...a }))
    return out
  }

  const Sn = S.map(normalizeForMatch)
  const An = A.map((a) => normalizeForMatch(a.text))
  const n = S.length
  const m = A.length
  const at = (i, j) => i * (m + 1) + j
  const NEG = -1e9
  const dp = new Float64Array((n + 1) * (m + 1)).fill(NEG)
  const back = new Array((n + 1) * (m + 1)).fill(null)
  dp[at(0, 0)] = 0

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[at(i, j)]
      if (cur === NEG) continue
      if (i < n && dp[at(i + 1, j)] < cur) {
        dp[at(i + 1, j)] = cur
        back[at(i + 1, j)] = { type: 'skipScript' }
      }
      if (j < m && dp[at(i, j + 1)] < cur) {
        dp[at(i, j + 1)] = cur
        back[at(i, j + 1)] = { type: 'skipAsr' }
      }
      for (let a = 1; a <= maxGroup && i + a <= n; a++) {
        for (let b = 1; b <= maxGroup && j + b <= m; b++) {
          if (a * b > 4) continue
          const sim = textSimilarity(Sn.slice(i, i + a).join(''), An.slice(j, j + b).join(''))
          if (sim < minSim) continue
          /* 合并相邻段要付代价（每多并一段扣 0.6）：能逐句 1:1 对上时绝不合并，
             只有「一句台词被静音切成了几段」这种确实需要时才合并。 */
          const score = cur + sim * (a + b - 1) - 0.6 * (a + b - 2)
          if (score > dp[at(i + a, j + b)]) {
            dp[at(i + a, j + b)] = score
            back[at(i + a, j + b)] = { type: 'match', a, b, sim }
          }
        }
      }
    }
  }

  const pairs = []
  let i = n
  let j = m
  let guard = 0
  while ((i > 0 || j > 0) && guard++ < n + m + 4) {
    const b = back[at(i, j)]
    if (!b) break
    if (b.type === 'match') {
      const asrRange = A.slice(j - b.b, j)
      pairs.push({
        start: asrRange[0].start,
        end: asrRange[asrRange.length - 1].end,
        text: S.slice(i - b.a, i).join(''),
        scriptFrom: i - b.a,
        scriptTo: i,
        asrFrom: j - b.b,
        asrTo: j,
        similarity: round3(b.sim),
        asrText: asrRange.map((x) => x.text).join(''),
      })
      i -= b.a
      j -= b.b
    } else if (b.type === 'skipScript') {
      out.unmatchedScript.unshift(S[i - 1])
      i -= 1
    } else {
      out.unmatchedAsr.unshift({ ...A[j - 1] })
      j -= 1
    }
  }
  pairs.reverse()
  out.pairs = pairs
  return out
}

/* ── 整句 → cue ──────────────────────────────────────────────────────────── */

/**
 * 整句 → 字幕 cue。
 * @param {Array<{start:number,end:number,text:string,source?:string}>} sentences 静音切句 + 转写结果
 * @param {{maxChars?:number, latin?:boolean, maxDurationSec?:number, breakPunctuation?:string,
 *          keepPunctuation?:boolean}} opts
 *   keepPunctuation：true = 标点一律原样不动（连句末句号也不裁）；默认 false =
 *   只去掉句末句号（问号 / 感叹号 / 句中标点照旧保留）。
 * @returns {Array<{index:number,start:number,end:number,duration:number,text:string,source?:string}>}
 */
export function buildSubtitleCues(sentences, opts = {}) {
  const maxChars = clampNum(opts.maxChars, 4, 200, SUBTITLE_MAX_CHARS_CJK)
  const maxDuration = clampNum(opts.maxDurationSec, 1, 60, SUBTITLE_MAX_SECONDS)
  const latin = opts.latin === true
  const keepPunct = opts.keepPunctuation === true
  const marks = String(opts.breakPunctuation == null ? SUBTITLE_BREAK_PUNCT : opts.breakPunctuation)

  const raw = []
  const pushRaw = (start, end, text, source) => {
    const t = String(text || '').trim()
    if (!t) return
    const s = round3(start)
    const e = Math.max(round3(end), round3(s + 0.05))
    raw.push({ start: s, end: e, text: t, source })
  }

  for (const seg of Array.isArray(sentences) ? sentences : []) {
    const start = Number(seg && seg.start)
    const end = Number(seg && seg.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const source = seg && typeof seg.source === 'string' && seg.source ? seg.source : ''
    const text = keepPunct ? String(seg.text == null ? '' : seg.text).trim() : stripFinalPeriod(seg.text)
    if (!text) continue

    /* 先按标点断成片段，再把每个超长片段硬切，最后按 maxChars 打包。 */
    const pieces = []
    for (const p of splitAfterPunctuation(text, marks)) {
      if (Array.from(p).length > maxChars) pieces.push(...hardSplit(p, maxChars, latin))
      else pieces.push(p)
    }
    const groups = packPieces(pieces, maxChars)
    if (!groups.length) continue

    const weights = groups.map(charWeight)
    const totalW = weights.reduce((a, b) => a + b, 0) || 1
    const span = end - start
    let acc = 0
    for (let i = 0; i < groups.length; i++) {
      const from = i === 0 ? start : start + (span * acc) / totalW
      acc += weights[i]
      const to = i === groups.length - 1 ? end : start + (span * acc) / totalW
      pushRaw(from, to, groups[i], source)
    }
  }

  /* 单条超过 maxDurationSec 的再按时间拆开（文本按字数占比同步拆）。 */
  const cues = []
  const addCue = (c) => {
    const t = String(c.text || '').trim()
    if (!t) return
    const s = round3(c.start)
    const e = Math.max(round3(c.end), round3(s + 0.05))
    cues.push({
      index: cues.length + 1,
      start: s,
      end: e,
      duration: round3(e - s),
      text: t,
      ...(c.source ? { source: String(c.source) } : {}),
    })
  }
  for (const c of raw) {
    const span = c.end - c.start
    if (span <= maxDuration + 1e-6) {
      addCue(c)
      continue
    }
    const parts = splitTextByCount(c.text, Math.ceil(span / maxDuration), latin)
    const n = parts.length || 1
    for (let i = 0; i < n; i++) {
      const from = i === 0 ? c.start : c.start + (span * i) / n
      const to = i === n - 1 ? c.end : c.start + (span * (i + 1)) / n
      addCue({ start: from, end: to, text: parts[i], source: c.source })
    }
  }
  return cues
}

/* ── 字幕文本（SRT / VTT）────────────────────────────────────────────────── */

/** 秒 → SRT 时间码（00:00:01,234）。 */
export function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

/** 秒 → VTT 时间码（00:00:01.234）。 */
export function vttTime(seconds) {
  return srtTime(seconds).replace(',', '.')
}

export function formatSrt(cues) {
  return (Array.isArray(cues) ? cues : [])
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
    .join('\n\n')
}

export function formatVtt(cues) {
  const body = (Array.isArray(cues) ? cues : [])
    .map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`)
    .join('\n\n')
  return 'WEBVTT\n\n' + body + (body ? '\n' : '')
}
