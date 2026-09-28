"use strict";
/* 会话最终答复不再停在「未渲染原文」态（用户报障：偶尔未正常渲染 md）
 *   node test/smoke-session-md-settle.js
 *
 * 背景（真源全在 renderer/ 里）：
 *   会话正文按「运行轨迹段」渲染。运行中只把**最后一个**轨迹段当「流式尾段」用纯文本
 *   就地追加（省掉每 token 重渲 markdown 的开销）—— 而「最终答复」按定义就是最后一个
 *   正文（say）段，于是它从第一个 token 起一直以未渲染原文的形态留在屏上，只有本轮
 *   finally 末尾那一次整体重绘才把它变回 markdown。那一帧前面还压着 persist /
 *   侧栏刷新等未加保护的步骤，任何一步抛错就轮不到它；收尾耗时也把「原文可见窗口」
 *   拉长 —— 用户看到的就是「最终答复偶尔没渲染 md」。
 *
 * 本轮口径：
 *   · renderer/app-db.js    say 段与 think 段一样带「是否仍在增长」标记：
 *                           tracePush 建段时 open:true，收口（say-end / 换 turn / 换
 *                           step / 调工具 / 报错）统一走 traceCloseSay 置 open:false；
 *   · renderer/app-assist.js agentLiveSegsEl：只有**仍开放**的尾段走纯文本，已收口的
 *                           正文段（即使还是尾段）按 markdown 渲染；agentLiveSegTail
 *                           不再把已收口段当就地更新目标（返回 null → 整表重绘）；
 *                           会话 onEvent 收到 say-end 且该段正好是尾段 → 就地重绘一次；
 *                           finally 一置 st.running=false 就先落定一次界面（重绘排到
 *                           persist / 侧栏刷新之前，任何一步失败都挡不住它）。
 *
 * 覆盖：
 *   [1] 源码口径：开合标记与唯一收口出口
 *   [2] 真实 tracePush 行为（vm）：say-end / 工具 / 换 step 收口，续写另起新段
 *   [3] 落盘段快照不带界面状态位（open 不进存档）
 *   [4] 渲染接线：尾段判定 / 就地更新闸 / say-end 重绘 / finally 先落定
 *   [5] 真实 agentLiveSegTail 行为（vm）：已收口段不再被当作就地更新目标
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "（未找到）"));
const countOf = (src, re) => (src.match(re) || []).length;

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (isFn) {
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  let depth2 = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[") depth2++;
    else if (c === "}" || c === "]") {
      depth2--;
      if (!depth2) return src.slice(at, j + 1) + ";";
    }
  }
  throw new Error("常量体不完整：" + name);
}
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");

/* ==================== [1] 源码口径 ==================== */
console.log("\n[1] say 段开合标记 + 唯一收口出口");
has(DB, "function traceCloseSay(tr) {", "app-db.js 新增 traceCloseSay（正文段收口出口）");
ok(
  countOf(DB, /tr\._openSay = false;/g) === 1,
  "tr._openSay = false 只剩 traceCloseSay 里那一处（旧散点全部改走收口函数；实得 " +
    countOf(DB, /tr\._openSay = false;/g) +
    " 处）",
);
ok(
  /function traceCloseSay\(tr\) \{[\s\S]{0,400}?if \(last && last\.k === "say" && last\.open !== false\) last\.open = false;/.test(
    DB,
  ),
  "traceCloseSay 只把当时最后那一条 say 段标记为已定稿（思考 / 工具 / 错误段不动）",
);
has(DB, 'const it = { k: "say", text: body, step, callId: "", open: true };', "新建正文段带 open:true（与 think 段同一套「仍在增长」语义）");
ok(
  countOf(DB, /traceCloseSay\(tr\);/g) >= 5,
  "所有收口点（say-end / turn / step / tool / err）都走 traceCloseSay（实得 " +
    countOf(DB, /traceCloseSay\(tr\);/g) +
    " 处）",
);
ok(
  /if \(traceThinkEventSameStream\(tr, e, turn, step\)\) traceThinkCloseIfBig\(tr\);[\s\S]{0,300}?traceCloseSay\(tr\);[\s\S]{0,120}?const it = \{ k: "tool"/.test(
    DB,
  ),
  "工具段：先把正文段收口再落工具段（顺序不能反）",
);

/* ==================== [2] 真实 tracePush 行为（vm） ==================== */
console.log("\n[2] 真实 tracePush：收口后不再并进，续写另起新段");
const S = {};
const sandbox = { S, console };
vm.createContext(sandbox);
vm.runInContext(
  constLine(DB, "THINK_TINY_CHARS") +
    "\n" +
    extract(DB, [
      "traceRunKey",
      "traceNum",
      "traceReset",
      "traceOf",
      "joinThinkText",
      "traceStreamKey",
      "traceToolSeq",
      "traceThinkOpenItem",
      "traceThinkEventSameStream",
      "traceThinkCloseIfBig",
      "traceCloseThink",
      "traceCloseSay",
      "tracePush",
      "traceText",
    ]),
  sandbox,
  { filename: "session-md-settle-extract.js" },
);
const G = (name) =>
  vm.runInContext(
    "(typeof " + name + " === 'undefined' ? null : " + name + ")",
    sandbox,
  );
["traceCloseSay", "tracePush", "traceText"].forEach((n) =>
  ok(typeof G(n) === "function", "vm 抽到真实函数：" + n),
);
const saySegs = (rk) => {
  const tr = S.runTrace[G("traceRunKey")(rk)];
  return (tr && tr.items ? tr.items : []).filter((it) => it.k === "say");
};

/* [2a] say-end 收口：段标定稿，续写另起新段（不再并回定稿段） */
const RK1 = "mdSettle:sayend";
G("traceReset")(RK1);
G("tracePush")(RK1, "say", "# 最终答复", { turn: 1, step: 4, index: 0 });
let segs = saySegs(RK1);
ok(segs.length === 1 && segs[0].open === true, "正文段建出来时 open=true（还在增长）");
G("tracePush")(RK1, "say-end", "", { turn: 1, step: 4, index: 0 });
ok(segs[0].open === false, "say-end 一到，该段立即定稿（open=false）→ 渲染层改走 markdown");
G("tracePush")(RK1, "say", "补充一句", { turn: 1, step: 4, index: 1 });
segs = saySegs(RK1);
ok(
  segs.length === 2 && segs[1].open === true && segs[1].text === "补充一句",
  "收口后的续写另起新段（定稿段不被改写、不重新打开）",
);
ok(segs[0].text === "# 最终答复", "定稿段正文原样保留（渲染出的 markdown 与前一段一致）");

/* [2b] 工具调用 / 换 step 同样收口 */
const RK2 = "mdSettle:tool";
G("traceReset")(RK2);
G("tracePush")(RK2, "say", "看完代码再答", { turn: 1, step: 1 });
G("tracePush")(RK2, "tool", "", { turn: 1, step: 1, callId: "c1" });
ok(saySegs(RK2)[0].open === false, "调工具前先把正文段收口（顺序：正文定稿 → 工具段）");
const tr2 = S.runTrace[G("traceRunKey")(RK2)];
ok(
  tr2.items[0].k === "say" && tr2.items[1].k === "tool",
  "轨迹顺序仍是「正文 → 工具」（收口没有插队）",
);

const RK3 = "mdSettle:step";
G("traceReset")(RK3);
G("tracePush")(RK3, "say", "第一段", { turn: 1, step: 1 });
G("tracePush")(RK3, "say", "第二段", { turn: 1, step: 2 });
segs = saySegs(RK3);
ok(
  segs.length === 2 && segs[0].open === false && segs[1].open === true,
  "换 step = 上一段收口 + 新开放段",
);
G("tracePush")(RK3, "say", "第二段续写", { turn: 1, step: 2 });
segs = saySegs(RK3);
ok(
  segs.length === 2 && segs[1].text === "第二段第二段续写",
  "新段仍在开放 → 同 step 增量照旧并进这一段（流式不碎段）",
);
ok(G("traceText")(RK3, "say") === "第一段\n\n第二段第二段续写", "全文口径不变（段间空行）");

/* ==================== [3] 落盘段快照不带界面状态位 ==================== */
console.log("\n[3] open 只活在运行轨迹里，不进存档");
has(
  DB,
  "out.push({ k: it.k, step: it.step, text });",
  "traceSegmentsOf 只带 k / step / text（open 不随消息落盘）",
);
has(
  ASSIST,
  "const o = { k: s.k, text, step: s.step != null ? s.step : null };",
  "agentSegsForDisk 也只带 k / text / step（+callId）",
);

/* ==================== [4] 渲染接线 ==================== */
console.log("\n[4] 渲染接线：只有仍开放的尾段走纯文本，收尾必落定一次");
has(
  ASSIST,
  "const stillStreaming = streaming && !(seg.k === \"say\" && seg.open === false);",
  "agentLiveSegsEl：已收口的正文段即使还是尾段也按 markdown 渲染",
);
ok(
  /if \(stillStreaming\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?md\.innerHTML = renderMarkdown\(/.test(
    ASSIST,
  ),
  "纯文本分支与 markdown 分支的分工保持原样（只是判定换成了 stillStreaming）",
);
has(
  ASSIST,
  'if (kind === "say" && last.open === false) return null;',
  "agentLiveSegTail：已收口段不再当就地更新目标（返回 null → 调用方整表重绘）",
);
has(
  ASSIST,
  '} else if (type === "say-end") {',
  "会话 onEvent 新增 say-end 分支（正文块收尾即重绘一次）",
);
ok(
  /type === "say-end"[\s\S]{0,600}?const items = agentChatSegItems\(st\) && agentTraceItems\("agent:" \+ st\.id\);[\s\S]{0,300}?last\.k === "say" && last\.open === false[\s\S]{0,120}?renderAgentSession\(\);/.test(
    ASSIST,
  ),
  "say-end 只在「刚收口的正文段正好是尾段」时重绘（后面还有工具 / 思考段就不白刷）",
);
ok(
  /st\.running = false;\s*\n\s*st\._cancelled = false;\s*\n\s*st\._liveTools = \[\];[\s\S]{0,700}?if \(agentViewIs\(st\)\) renderAgentSession\(\);/.test(
    ASSIST,
  ),
  "finally 一置 st.running=false 就先落定一次界面（排在 persist / 侧栏刷新之前）",
);
ok(
  ASSIST.indexOf("旧口径里渲染是\n") > 0 ||
    /finally 的最后一句，前面 persist/.test(ASSIST),
  "注释写清根因：渲染原先是 finally 最后一句，前面任一步抛错就轮不到它",
);

/* ==================== [5] 真实 agentLiveSegTail 行为（vm） ==================== */
console.log("\n[5] 真实 agentLiveSegTail：已收口段不再被就地纯文本覆盖");
const sb2 = { Number, console };
vm.createContext(sb2);
vm.runInContext(fnBody(ASSIST, "agentLiveSegTail"), sb2, {
  filename: "agentLiveSegTail.js",
});
const tailFn = vm.runInContext("agentLiveSegTail", sb2);
const el0 = { dataset: { segIdx: "0" } };
ok(
  tailFn([{ k: "say", text: "还在写", open: true }], el0, "say") !== null,
  "开放中的尾段：照旧返回该段（就地纯文本追加）",
);
ok(
  tailFn([{ k: "say", text: "已定稿", open: false }], el0, "say") === null,
  "已收口的尾段：返回 null（调用方整表重绘 → 渲染成 markdown）",
);
ok(
  tailFn([{ k: "tool", step: 1 }], el0, "say") === null,
  "段类型对不上照旧 null",
);
ok(
  tailFn([{ k: "say", text: "x", open: true }], { dataset: { segIdx: "3" } }, "say") ===
    null,
  "段序对不上照旧 null（刚从别的段切过来时整表重绘一次）",
);

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-session-md-settle)",
);
process.exit(fails ? 1 : 0);
