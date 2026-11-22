"use strict";
/* ============ 会话反查（session recall）· Agent 工具 mtnode_recall 的宿主侧 ============
 *
 * 为什么要有它：一段长任务里，早期原文会**离开模型上下文**，而原文一条都没被删 ——
 * 三条来路各自把内容挡在上下文之外，且都只发生在「发给模型的那一段」：
 *   ① 手动压缩：app-assist.js 的 agentCompactApply 只给消息盖 `_fold`（唯一过滤点是
 *      app-db.js 的 agentHistoryEntries），
 *   ② 运行时自动压缩：网关把 compaction/summary 记成 st.compacts[] 的 kind:'auto'
 *      （带摘要 + 被遮蔽条数），消息本身照旧留着，
 *   ③ 连压缩都没触发时：历史段按 AGENT_HIST_MAX_CHARS 从最早处丢（agentHistTrimTail）。
 * 所以「反查」不需要第二份真相（不读 dsh 的 session.jsonl），只用宿主自己的会话存储：
 * 本文件按 msgIndex / 关键词 / 区间把逐字原文取回来，让模型照着原话说，而不是凭记忆编。
 *
 * 分工（与 app-manifest.js / app-ai-facts.js 同一套）：
 *   · 纯逻辑：输入「会话状态 st + 参数」→ 结果对象。不碰 DOM、不碰 window、不写任何东西，
 *     四个动作（outline / search / read / context）全在这一层；可被 vm 抠出来真跑
 *     （与 agentCompactApply 同一手法，见 test/smoke-session-recall.js）。
 *   · 宿主接线：帧 {t:'recall'} → 定位会话（本轮绑定会话 > 显式 sessionId）→ 正文没加载
 *     就经 agentEnsureSessionBody 补读（读不到回错误文本）→ 跑纯逻辑 → 回执走
 *     dshInteract({kind:'recall', id, result, error})，由网关以 recall-result 原路还给插件
 *     （dsh/gateway/session-recall-plugin.mjs）。失败一律回错误文本 = 这一次工具调用失败，
 *     会话继续跑（与 db / facts / manifest 同一口径）。
 *
 * 上限口径（插件描述里承诺的数就是这里这几个常量，两处不许分叉）：
 *   outline  最多 80 行；search limit 默认 8 / 上限 30、总回包 ≤8000 字、单条片段 ≤300 字
 *            （命中点前后各 120 字）；read maxChars 默认 4000 / 上限 20000，超出即截断并
 *            标注「…（已截断，本条共 N 字）」；context 只回区间与压缩记录（不回正文）。
 *   共同的纪律：单次调用绝不把整份会话（5 MB 级）塞进回包、也绝不改动任何消息。
 *
 * 加载：renderer/index.html 排在 app-manifest.js 之后。本文件顶层不引用任何后加载绑定
 * （agentSessionById / agentSessionOfRun / agentEnsureSessionBody / agentHistoryEntries
 * 全在**调用期**按 typeof 取用），所以装载顺序不影响首帧。公开接口：window.MTNodeSessionRecall。
 */

/* ── 上限常量（唯一真源） ─────────────────────────────────────────────────── */
var SR_OUTLINE_ROWS = 80; /* outline 最多列几轮 */
var SR_OUTLINE_HEAD = 60; /* 每行取多少字做开头 */
var SR_SEARCH_LIMIT_DEFAULT = 8;
var SR_SEARCH_LIMIT_MAX = 30;
var SR_SEARCH_TOTAL_CHARS = 8000; /* 整个 search 回包的字符预算 */
var SR_SEARCH_PAD = 120; /* 命中点前后各取多少字 */
var SR_SEARCH_SNIPPET_MAX = 300; /* 单条片段字数上限 */
var SR_SEARCH_Q_MAX = 200; /* 关键词串最长多少字（夹住，免得拿整篇文当模式） */
var SR_SEARCH_WORDS_MAX = 12; /* AND 关键词最多几个 */
var SR_READ_CHARS_DEFAULT = 4000;
var SR_READ_CHARS_MAX = 20000;
var SR_READ_FIELD_MAX = 1000; /* read 的 with:tools 里入参 / 结果各自最多多少字 */
var SR_LINE_OVERHEAD = 40; /* 估回包体积时每条命中 / 每行的固定开销（i / role / 字段名等） */
var SR_CONTEXT_SUMMARY_HEAD = 80; /* context 里压缩摘要露多少字 */
var SR_COMPACT_LIST_MAX = 40; /* 压缩记录最多列几条（st.compacts 本来就只留 40） */

/* ── 小工具（纯函数） ─────────────────────────────────────────────────────── */

function srPad2(n) {
  return (n < 10 ? "0" : "") + String(n);
}
/* 时间戳 → 「YYYY-MM-DD HH:MM」（本地时区）。拿不到有效时间就回空串，绝不写 NaN */
function srFmtTime(at) {
  const t = Number(at) || 0;
  if (!t) return "";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  return (
    d.getFullYear() +
    "-" +
    srPad2(d.getMonth() + 1) +
    "-" +
    srPad2(d.getDate()) +
    " " +
    srPad2(d.getHours()) +
    ":" +
    srPad2(d.getMinutes())
  );
}
/* 数字参数夹取：空串 / null / 非数字一律当没给（回 def），给了就夹在 [min, max] 内 */
function srNum(v, def, min, max) {
  if (v === "" || v == null) return def;
  const n = Number(v);
  if (!isFinite(n)) return def;
  const lo = min == null ? n : min;
  const hi = max == null ? n : max;
  return Math.max(lo, Math.min(hi, n));
}
/* 数字参数：给了整数才回，否则 null（read 的 from/to 用得上：只认显式数字） */
function srIntOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.trunc(n);
}
function srClip(s, max, mark) {
  const txt = String(s == null ? "" : s);
  const n = Math.max(0, Number(max) || 0);
  if (!n || txt.length <= n) return txt;
  return txt.slice(0, n) + (mark == null ? "…" : String(mark));
}
/* 会话消息清单（只读：不复制、不改动） */
function srMessagesOf(st) {
  return st && Array.isArray(st.messages) ? st.messages : [];
}
function srTextOf(m) {
  return m && typeof m.content === "string" ? m.content : "";
}
function srRoleOf(m) {
  const r = String((m && m.role) || "");
  return r === "user" || r === "assistant" ? r : r || "?";
}

/* ── 工具记录（m.tools 的条目）→ 纯文本 ──────────────────────────────────
   字段口径与 app-assist.js 的 agentCompactArgsText / agentCompactResultText /
   agentCompactErrorText 一致（args 可能是 JSON 串，result 可能是 content 块数组，
   error 可能是 {name,code,message}）—— 这里自带一份，因为纯逻辑要能被 vm 单独抠出来跑。 */
function srToolNameOf(t) {
  return String((t && t.name) || "").trim();
}
function srToolArgsText(t) {
  const a = t && t.args;
  if (a == null || a === "") return "";
  if (typeof a === "string") return a;
  try {
    const j = JSON.stringify(a);
    return typeof j === "string" ? j : "";
  } catch (_) {
    return String(a);
  }
}
function srToolResultText(t) {
  const r = t && t.result;
  if (Array.isArray(r)) {
    const parts = [];
    for (const b of r) {
      if (!b) continue;
      if (typeof b === "string") parts.push(b);
      else if (typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n\n").trim();
  }
  if (typeof r === "string") return r.trim();
  if (r && typeof r === "object") {
    try {
      const j = JSON.stringify(r);
      return typeof j === "string" ? j : "";
    } catch (_) {
      return "";
    }
  }
  return "";
}
function srToolErrorText(t) {
  const e = t && t.error;
  if (e == null) return "";
  if (typeof e === "string") return e;
  const bits = [];
  if (e.name) bits.push(String(e.name));
  if (e.code) bits.push(String(e.code));
  const msg = e.message || e.detail || (e.cause && e.cause.message) || "";
  return bits.join(" ") + (msg ? (bits.length ? "\n" : "") + String(msg) : "");
}
/* 一条工具记录 → 一段可读文字（read 的 with:tools 用） */
function srToolLinesOf(t) {
  if (!t) return "";
  const name = srToolNameOf(t);
  const args = srToolArgsText(t);
  const res = srToolResultText(t);
  const err = srToolErrorText(t);
  if (!name && !args && !res && !err) return "";
  const lines = ["[工具] " + (name || "（未记名）")];
  if (args) lines.push("入参: " + srClip(args, SR_READ_FIELD_MAX, "…（已截断）"));
  if (err) lines.push("错误: " + srClip(err, SR_READ_FIELD_MAX, "…（已截断）"));
  else if (res) lines.push("结果: " + srClip(res, SR_READ_FIELD_MAX, "…（已截断）"));
  return lines.join("\n");
}

/* ── 上下文边界（复用 app-db.js 的口径，只算不写） ──────────────────────────
   真源就是 agentHistoryEntries（_src / _fold / 同文去重 / 200k 字符截断全在它里面），
   这里只是把「这一轮历史段里还剩哪些消息」翻译成一个 Set（按消息对象引用比）。
   AGENT_HIST_MAX_CHARS 也现读 —— 不另抄一份数，改了那边这里跟着变。
   返回 null = 那份口径不可用（app-db.js 没加载 / 老壳），调用方按「未知」处理，绝不假装。 */
function srHistBoundary(st) {
  if (typeof agentHistoryEntries !== "function") return null;
  const stats = {};
  let rows = null;
  try {
    /* skipLast:false —— 边界回答的是「哪些消息还在上下文里」，当前这条也在；
       stats 回填 dropped / total（被字符预算丢掉的条数）。 */
    rows = agentHistoryEntries(st, { withMsg: true, skipLast: false, stats: stats });
  } catch (_) {
    return null;
  }
  const set = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.msg) set.add(r.msg);
  }
  return {
    set: set,
    kept: set.size,
    dropped: Math.max(0, Number(stats.dropped) || 0),
    total: Math.max(0, Number(stats.total) || 0),
    maxChars: typeof AGENT_HIST_MAX_CHARS === "number" ? AGENT_HIST_MAX_CHARS : null,
  };
}
/* 某条消息此刻还在不在上下文里：boundary 为 null 时回 null（未知，不猜） */
function srInContext(boundary, m) {
  if (!boundary || !boundary.set) return null;
  return boundary.set.has(m);
}

/* ── 索引区间压缩（context 动作用：几百条索引压成 [起, 止] 区间，回包才小） ── */
function srRangesOf(indices) {
  const out = [];
  let start = null;
  let prev = null;
  for (const raw of Array.isArray(indices) ? indices : []) {
    const i = Number(raw);
    if (!isFinite(i)) continue;
    if (start == null) {
      start = i;
      prev = i;
    } else if (i === prev + 1) {
      prev = i;
    } else {
      out.push([start, prev]);
      start = i;
      prev = i;
    }
  }
  if (start != null) out.push([start, prev]);
  return out;
}

/* ── search 的关键词 → 匹配器 ──────────────────────────────────────────────
   q 的写法：空格分隔 = AND；整串写成 /…/ 就按正则（flags 收 g / y，免得 exec 的
   lastIndex 串味）。关键词串本身夹在 SR_SEARCH_Q_MAX 字以内。 */
function srMatchersOf(q) {
  const raw = String(q == null ? "" : q).trim();
  if (!raw) {
    return {
      error: "search 需要关键词 q（空格分隔 = AND，/…/ 视为正则）",
    };
  }
  const spec = raw.slice(0, SR_SEARCH_Q_MAX);
  const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(spec);
  if (m) {
    const flags = String(m[2] || "").replace(/[gy]/g, "");
    let re = null;
    try {
      re = new RegExp(m[1], flags);
    } catch (e) {
      return { error: "正则写法有误：" + String((e && e.message) || e) };
    }
    return { list: [{ kind: "re", re: re }], spec: spec, regex: true };
  }
  const words = spec.split(/\s+/).filter(Boolean).slice(0, SR_SEARCH_WORDS_MAX);
  if (!words.length) {
    return { error: "search 需要关键词 q（空格分隔 = AND，/…/ 视为正则）" };
  }
  return {
    list: words.map((w) => ({ kind: "word", needle: w.toLowerCase() })),
    spec: spec,
    regex: false,
  };
}
/* 一条匹配器在文本里第一次出现的位置（找不到回 null） */
function srFirstMatch(text, matchers) {
  const s = String(text == null ? "" : text);
  if (!s) return null;
  const low = s.toLowerCase();
  for (const mt of matchers) {
    if (!mt) continue;
    if (mt.kind === "re") {
      mt.re.lastIndex = 0;
      const m = mt.re.exec(s);
      if (m) return { at: Math.max(0, m.index), len: String(m[0] || "").length };
      continue;
    }
    const at = low.indexOf(mt.needle);
    if (at >= 0) return { at: at, len: mt.needle.length };
  }
  return null;
}
/* AND 语义：每一条匹配器都得在文本里出现 */
function srMatchesAll(text, matchers) {
  const s = String(text == null ? "" : text);
  if (!s) return false;
  const low = s.toLowerCase();
  for (const mt of matchers) {
    if (!mt) continue;
    if (mt.kind === "re") {
      mt.re.lastIndex = 0;
      if (!mt.re.test(s)) return false;
      continue;
    }
    if (low.indexOf(mt.needle) < 0) return false;
  }
  return true;
}
/* 命中点前后各 SR_SEARCH_PAD 字，整条夹在 SR_SEARCH_SNIPPET_MAX 字内 */
function srSnippetOf(text, hit) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  const at = Math.max(0, Math.min(s.length, Number(hit && hit.at) || 0));
  const len = Math.max(0, Number(hit && hit.len) || 0);
  let start = Math.max(0, at - SR_SEARCH_PAD);
  let end = Math.min(s.length, at + len + SR_SEARCH_PAD);
  if (end - start > SR_SEARCH_SNIPPET_MAX) end = Math.min(s.length, start + SR_SEARCH_SNIPPET_MAX);
  if (end <= start) end = Math.min(s.length, start + SR_SEARCH_SNIPPET_MAX);
  let out = s.slice(start, end).replace(/\s+/g, " ");
  if (start > 0) out = "…" + out;
  if (end < s.length) out = out + "…";
  return out;
}

/* ── 动作 ①：outline（按轮列 user 消息） ──────────────────────────────────
   一轮 = 一条 user 消息 + 它之后到下一个 user 消息之间的那些 assistant 消息；
   「该轮工具数 / 字符数」都按这个范围数（工具数 = 这段里 assistant 的 m.tools 条数）。
   「是否已出上下文」= srInContext 的结论（null = 口径不可用，如实标未知）。
   params.max 只是给单测 / 内部调用压低上限用的，工具面没有这个参数（夹在 1–80）。 */
function srTurnsOf(list) {
  const turns = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || srRoleOf(m) !== "user") continue;
    const text = srTextOf(m);
    let tools = 0;
    let chars = text.length;
    for (let j = i + 1; j < list.length; j++) {
      const nx = list[j];
      if (!nx) continue;
      if (srRoleOf(nx) === "user") break;
      chars += srTextOf(nx).length;
      if (Array.isArray(nx.tools)) tools += nx.tools.length;
    }
    turns.push({ i: i, msg: m, text: text, tools: tools, chars: chars });
  }
  return turns;
}
function srOutlineOf(st, params) {
  const list = srMessagesOf(st);
  const boundary = srHistBoundary(st);
  const turns = srTurnsOf(list);
  const maxRows = srNum(params && params.max, SR_OUTLINE_ROWS, 1, SR_OUTLINE_ROWS);
  const rows = [];
  for (const t of turns.slice(0, maxRows)) {
    const m = t.msg;
    const inCtx = srInContext(boundary, m);
    rows.push({
      i: t.i,
      time: srFmtTime(m && m.at),
      head: srClip(String(t.text || "").replace(/\s+/g, " ").trim(), SR_OUTLINE_HEAD, "…"),
      tools: t.tools,
      chars: t.chars,
      /* in / out / unknown：out 就是「已出上下文」的那些（被压缩折起、或被字符预算丢掉） */
      ctx: inCtx === null ? "unknown" : inCtx ? "in" : "out",
      fold: String((m && m._fold) || ""),
      src: String((m && m._src) || ""),
    });
  }
  const out = {
    ok: true,
    action: "outline",
    totalMessages: list.length,
    turnCount: turns.length,
    shown: rows.length,
    truncated: turns.length > rows.length,
    turns: rows,
  };
  if (out.truncated) {
    out.nextFrom = rows.length ? rows[rows.length - 1].i + 1 : 0;
    out.note =
      "只列前 " +
      rows.length +
      " 轮（上限 " +
      SR_OUTLINE_ROWS +
      "）；还有 " +
      (turns.length - rows.length) +
      " 轮没列，用 read 的 from/to 按索引继续取";
  }
  if (!boundary) out.boundaryNote = "上下文边界口径不可用（ctx 一律标 unknown）";
  else
    out.boundary = {
      kept: boundary.kept,
      dropped: boundary.dropped,
      total: boundary.total,
      maxChars: boundary.maxChars,
    };
  return out;
}

/* ── 动作 ②：search（关键词扫正文；scope:'all' 连带 reasoning 与工具记录） ──
   一条消息一条命中（where 指出命中最先落在哪一块），片段取命中最靠前的那一块。 */
function srSearchPartsOf(m, scope) {
  const parts = [];
  const content = srTextOf(m);
  if (content) parts.push({ where: "content", text: content });
  if (String(scope || "") === "all") {
    const rsn = String((m && m.reasoning) || "");
    if (rsn) parts.push({ where: "reasoning", text: rsn });
    for (const t of Array.isArray(m && m.tools) ? m.tools : []) {
      const line = srToolLinesOf(t);
      if (line) parts.push({ where: "tool", text: line, tool: srToolNameOf(t) });
    }
  }
  return parts;
}
function srSearchHitOf(m, matchers, scope) {
  const parts = srSearchPartsOf(m, scope);
  if (!parts.length) return null;
  const joined = parts.map((p) => p.text).join("\n");
  if (!srMatchesAll(joined, matchers)) return null;
  /* 片段从「最先命中的那一块」取；一块都单独摸不到（关键词分散在几块里）就退回整段拼接 */
  let best = null;
  for (const p of parts) {
    const f = srFirstMatch(p.text, matchers);
    if (f && (!best || f.at < best.at)) best = { at: f.at, len: f.len, where: p.where, text: p.text };
  }
  if (!best) {
    /* 关键词分散在几块里、没有哪一块独自全中：退回整段拼接取片段（where 标 content） */
    const f = srFirstMatch(joined, matchers) || { at: 0, len: 0 };
    best = { at: f.at, len: f.len, where: "content", text: joined };
  }
  return { where: best.where, snippet: srSnippetOf(best.text, best) };
}
function srSearchOf(st, params) {
  const list = srMessagesOf(st);
  const scope = String((params && params.scope) || "user").toLowerCase() === "all" ? "all" : "user";
  const mt = srMatchersOf(params && params.q);
  if (mt.error) return { ok: false, error: mt.error };
  const limit = srNum(params && params.limit, SR_SEARCH_LIMIT_DEFAULT, 1, SR_SEARCH_LIMIT_MAX);
  const hits = [];
  let used = 0;
  let totalHits = 0;
  let budgetHit = false;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m) continue;
    const hit = srSearchHitOf(m, mt.list, scope);
    if (!hit) continue;
    totalHits++;
    if (hits.length >= limit) continue;
    const lineOverhead = SR_LINE_OVERHEAD;
    if (used + hit.snippet.length + lineOverhead > SR_SEARCH_TOTAL_CHARS) {
      budgetHit = true;
      continue;
    }
    used += hit.snippet.length + lineOverhead;
    hits.push({
      i: i,
      role: srRoleOf(m),
      where: hit.where,
      time: srFmtTime(m && m.at),
      snippet: hit.snippet,
      /* 命中这条消息需要原文全文时，用 read 的 index 取 */
    });
  }
  const out = {
    ok: true,
    action: "search",
    q: mt.spec,
    regex: !!mt.regex,
    scope: scope,
    totalHits: totalHits,
    shown: hits.length,
    hits: hits,
  };
  if (!hits.length) {
    out.note = "没有命中：换个关键词再试（scope:'all' 也会扫思考与工具记录）；查不到就如实说查不到";
  } else if (totalHits > hits.length) {
    out.note =
      "共命中 " +
      totalHits +
      " 条，只回了 " +
      hits.length +
      " 条（limit " +
      limit +
      (budgetHit ? "，且已达回包字数上限" : "") +
      "）；继续找就收窄关键词或调大 limit（上限 " +
      SR_SEARCH_LIMIT_MAX +
      "）";
  }
  return out;
}

/* ── 动作 ③：read（按 msgIndex 或 from/to 区间取原文） ──────────────────── */
function srWithOf(params) {
  const w = String((params && params.with) || "").toLowerCase();
  return w === "reasoning" || w === "tools" || w === "both" ? w : "";
}
function srReadOf(st, params) {
  const list = srMessagesOf(st);
  const total = list.length;
  if (!total) {
    return { ok: true, action: "read", totalMessages: 0, items: [], note: "该会话没有消息" };
  }
  const budget = srNum(
    params && params.maxChars,
    SR_READ_CHARS_DEFAULT,
    1,
    SR_READ_CHARS_MAX,
  );
  const withWhat = srWithOf(params);
  const one = srIntOrNull(params && params.index);
  let from = one;
  let to = one;
  if (from === null) {
    from = srIntOrNull(params && params.from);
    to = srIntOrNull(params && params.to);
  }
  if (from === null) {
    return {
      ok: false,
      error: "read 需要 index，或 from/to 区间（索引见 outline / search 回的 i）",
    };
  }
  if (to === null) to = from;
  if (to < from) {
    const t = from;
    from = to;
    to = t;
  }
  if (from < 0 || from >= total) {
    return {
      ok: false,
      error: "索引越界：" + from + " 不在 0–" + (total - 1) + " 之间（共 " + total + " 条消息）",
    };
  }
  if (to >= total) to = total - 1;
  let left = budget;
  const items = [];
  let cut = false;
  for (let i = from; i <= to && i < total; i++) {
    if (left <= 0) {
      cut = true;
      break;
    }
    const m = list[i];
    if (!m) continue;
    const text = srTextOf(m);
    const take = Math.min(left, text.length);
    const clipped = take < text.length;
    let body = text.slice(0, take);
    if (clipped) body += "…（已截断，本条共 " + text.length + " 字）";
    left -= body.length;
    const item = {
      i: i,
      role: srRoleOf(m),
      time: srFmtTime(m && m.at),
      chars: text.length,
      truncated: clipped,
      text: body,
    };
    if (String((m && m._fold) || "")) item.fold = String(m._fold);
    if (withWhat === "reasoning" || withWhat === "both") {
      const rsn = String((m && m.reasoning) || "");
      if (rsn) {
        const takeR = Math.min(left, rsn.length);
        item.reasoning = takeR < rsn.length ? rsn.slice(0, takeR) + "…（已截断，本条共 " + rsn.length + " 字）" : rsn;
        left -= item.reasoning.length;
      }
    }
    if (withWhat === "tools" || withWhat === "both") {
      const list2 = Array.isArray(m && m.tools) ? m.tools : [];
      const lines = [];
      for (const t of list2) {
        const line = srToolLinesOf(t);
        if (!line) continue;
        if (left <= 0) {
          lines.push("…（工具记录还有 " + (list2.length - lines.length) + " 条未回，已到字数上限）");
          cut = true;
          break;
        }
        const takeT = Math.min(left, line.length);
        lines.push(takeT < line.length ? line.slice(0, takeT) + "…（已截断）" : line);
        left -= Math.min(takeT, line.length);
      }
      if (lines.length) item.tools = lines;
    }
    items.push(item);
  }
  if (items.length < to - from + 1) cut = true;
  const out = {
    ok: true,
    action: "read",
    totalMessages: total,
    from: from,
    to: to,
    returned: items.length,
    budget: budget,
    items: items,
  };
  if (cut) {
    out.note =
      "已到字数上限（maxChars " +
      budget +
      "，上限 " +
      SR_READ_CHARS_MAX +
      "）：还有未回的内容，调大 maxChars 或分段再取";
  }
  return out;
}

/* ── 动作 ④：context（哪些索引还在本轮历史段里 + 已被压缩的区段） ──────────
   全部只算不写：agentHistoryEntries 是同一份口径（_src / _fold / 去重 / 200k 截断），
   compacts 直接读 st.compacts（手动 kind:'manual'、运行时自动 kind:'auto'）。 */
function srContextOf(st) {
  const list = srMessagesOf(st);
  const boundary = srHistBoundary(st);
  const inIdx = [];
  const outIdx = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const inCtx = srInContext(boundary, m);
    if (inCtx === null) continue;
    (inCtx ? inIdx : outIdx).push(i);
  }
  const compacts = [];
  const raw = st && Array.isArray(st.compacts) ? st.compacts.slice(-SR_COMPACT_LIST_MAX) : [];
  for (const c of raw) {
    if (!c) continue;
    const summary = String(c.summary || "");
    compacts.push({
      /* 老记录没写 kind 的一律按 manual（与 app-assist.js 的 compactLatestOf 同口径） */
      kind: c.kind === "auto" ? "auto" : "manual",
      time: srFmtTime(c.at),
      count: Math.max(0, Number(c.count) || 0),
      chars: Math.max(0, Number(c.chars) || 0),
      summaryHead: srClip(summary.replace(/\s+/g, " ").trim(), SR_CONTEXT_SUMMARY_HEAD, "…"),
    });
  }
  const out = {
    ok: true,
    action: "context",
    totalMessages: list.length,
    /* 区间写法：几百条索引也只占几十个字符 */
    inContext: srRangesOf(inIdx),
    outContext: srRangesOf(outIdx),
    kept: inIdx.length,
    outCount: outIdx.length,
    compacts: compacts,
  };
  if (!boundary) {
    return Object.assign(out, {
      ok: false,
      error: "上下文边界口径不可用（app-db.js 的 agentHistoryEntries 未加载）",
    });
  }
  out.maxChars = boundary.maxChars;
  out.dropped = boundary.dropped;
  out.note =
    "inContext 里的索引此刻随历史段发给模型，outContext 里的已经看不见了" +
    "（被压缩折起、或被 " +
    (boundary.maxChars == null ? "字符上限" : boundary.maxChars + " 字上限") +
    "丢掉：" +
    boundary.dropped +
    " 条）；它们的原文都还在，用 read 按索引取";
  return out;
}

/* ── 纯逻辑总入口：st + 参数 → 结果对象（任何异常都折成 ok:false + 文本，绝不抛） ── */
function srRun(st, params) {
  const p = params && typeof params === "object" ? params : {};
  const action = String(p.action == null ? "outline" : p.action).trim().toLowerCase();
  try {
    if (!st || typeof st !== "object") {
      return { ok: false, error: "该会话尚未加载 / 不存在" };
    }
    let out;
    if (action === "outline" || action === "") out = srOutlineOf(st, p);
    else if (action === "search") out = srSearchOf(st, p);
    else if (action === "read") out = srReadOf(st, p);
    else if (action === "context") out = srContextOf(st);
    else
      return {
        ok: false,
        error: "未知动作：" + action + "（可用 outline / search / read / context）",
      };
    if (out && typeof out === "object" && !out.sessionId) out.sessionId = String(st.id || "");
    return out;
  } catch (e) {
    return { ok: false, error: "会话反查失败：" + String((e && e.message) || e) };
  }
}

/* ── 宿主接线：会话定位 + 正文补读 + 回执 ───────────────────────────────── */

/* 定位会话：显式 sessionId（工具参数）> 本轮绑定会话（agentSessionOfRun）>
   帧上带的发起会话 id（运行时给的 exec.agent.id，与 facts / canvas 同一盖章口径）。
   显式值排在最前是工具描述的承诺（"sessionId：反查另一个会话（默认本会话）"）；
   不给就一律回落到本轮绑定会话 —— 计划并行子任务（planpar:…）也走同一条。
   取不到就回错误文本，绝不回退到「当前活动会话」（否则用户一切会话就查错人）。 */
function srResolveSession(data, params, opts) {
  const explicit = String((params && params.sessionId) || "").trim();
  const byId = (sid) => (typeof agentSessionById === "function" ? agentSessionById(sid) : null);
  if (explicit) {
    const st = byId(explicit);
    if (st) return { st: st };
    return { error: "该会话尚未加载 / 不存在（sessionId: " + explicit + "）" };
  }
  const ofRun = typeof agentSessionOfRun === "function" ? agentSessionOfRun(opts || {}) : null;
  if (ofRun) return { st: ofRun };
  const stamped = String((data && data.sessionId) || "").trim();
  if (stamped) {
    const st = byId(stamped);
    if (st) return { st: st };
    return { error: "该会话尚未加载 / 不存在（sessionId: " + stamped + "）" };
  }
  return {
    error: "该会话尚未加载 / 不存在（本轮没有绑定会话，调用里也没给 sessionId）",
  };
}

/* 正文补读：会话正文是懒加载的（启动只读索引），读回来才能反查。
   盘上没有这一份（损坏 / 手删）→ false = 调用方回「该会话尚未加载 / 不存在」。 */
async function srEnsureBody(st) {
  if (!st || !st.id) return false;
  if (st._lcMissing) return false;
  if (st._lcLoaded) return true;
  if (typeof agentEnsureSessionBody !== "function") {
    /* 老壳没装懒加载：手里这份就是全部（空会话照样如实回空，不报错） */
    return Array.isArray(st.messages);
  }
  try {
    await agentEnsureSessionBody(st);
  } catch (_) {
    return false;
  }
  return !!st._lcLoaded && !st._lcMissing;
}

/* Agent 工具帧：mtnode_recall（网关从 session-recall-plugin.mjs 转来的 {id, action, params}） */
async function handleSessionRecallToolEvent(data, opts, replyOverride) {
  const id = data && data.id;
  if (!id) return;
  const reply =
    typeof replyOverride === "function"
      ? replyOverride
      : (result, error) =>
          window.api
            .dshInteract({ kind: "recall", id, result, error: error || undefined })
            .catch(() => {});
  const p = Object.assign({}, (data && data.params) || {});
  if (!p.action && data && data.action) p.action = data.action;
  try {
    const r = srResolveSession(data, p, opts || {});
    if (r.error) {
      reply({ ok: false, error: r.error }, r.error);
      return;
    }
    const st = r.st;
    const loaded = await srEnsureBody(st);
    if (!loaded) {
      const err =
        "该会话尚未加载 / 不存在（会话文件缺失或损坏：sessionId " + String((st && st.id) || "") + "）";
      reply({ ok: false, error: err }, err);
      return;
    }
    const result = srRun(st, p);
    if (result && result.ok === false) reply(result, String(result.error || "会话反查失败"));
    else reply(result);
  } catch (e) {
    const err = String((e && e.message) || e);
    reply({ ok: false, error: err }, err);
  }
}

/* 公开接口：window.MTNodeSessionRecall（另有同层可直接叫的全局函数，
   见下；app-db.js 的分派按 typeof 取 handleSessionRecallToolEvent）。 */
window.MTNodeSessionRecall = {
  run: srRun,
  handle: handleSessionRecallToolEvent,
  outline: srOutlineOf,
  search: srSearchOf,
  read: srReadOf,
  context: srContextOf,
  resolveSession: srResolveSession,
  limits: {
    outlineRows: SR_OUTLINE_ROWS,
    searchLimitDefault: SR_SEARCH_LIMIT_DEFAULT,
    searchLimitMax: SR_SEARCH_LIMIT_MAX,
    searchTotalChars: SR_SEARCH_TOTAL_CHARS,
    readCharsDefault: SR_READ_CHARS_DEFAULT,
    readCharsMax: SR_READ_CHARS_MAX,
  },
};
