"use strict";
/* 思考分段：模型逐步思考时每步只吐十几 / 几十个字，但「思考 → 工具 → 思考」的
 * 交替时间线必须保留。renderer/app-db.js 的 tracePush 规则是「够长才收口」且
 * **按流分流**：一段思考写到 THINK_TINY_CHARS 才在本流（同一会话 id / 同一步）的
 * 工具调用或换 step 处封口（交替成块）；没写够就保持开放，把后续碎片继续吸进来。
 * 同一轮里并发到达的其它流（子代理 / 续跑轮）的正文 / 工具不参与本流收口 —— 否则
 * 每来一个字节就断一段，界面就是成排的「◉ 思考 · 8 字」（本机会话存档里实测到
 * think:4 / say / think:5 / say 这种交错）。
 * 本冒烟用 **真实 tracePush / traceText / traceThinkDisplay / joinThinkText /
 * traceThinkCloseIfBig / traceStreamKey / traceThinkEventSameStream** 钉住这条闸。
 *   node test/smoke-think-merge.js
 * 与 test/smoke-resume-on-retry.js 同一套路：用 vm 从源码里按名字抠出真实函数，
 * 不起真实模型、不拉网关子进程、零依赖。
 *
 * 覆盖：
 *   [1] 连续 40 个 15–60 字、step 递增的碎片 → 段数远小于 40，除最后一段（仍开放）
 *       外每段都够阈值，且拼接全文按原顺序包含全部字符
 *   [2] 单个 ≥阈值 的思考在边界处收口、另起一段（够长才交替）；小块继续并入开放段
 *   [3] 过短的思考跨 tool 段并回同一段（防碎片），够长的思考在工具处收口（保留交替），
 *       本流的 say / err / 换 turn 仍收口另起
 *   [4] 同一条思考流的增量原样相接（不插空格 —— 插空格正是「字符间被插入空格」的
 *       成因），跨 step / 跨工具才插换行；接缝已有空白不重复插
 *   [5] traceThinkDisplay 返回完整文本（不丢字、顺序不变）
 *   [6] 收尾落盘只夹工具段：思考 / 正文段全保留，落盘后仍按时间线原位分段渲染
 *       （旧口径一超段数上限就「只留 think」，say 被甩掉 → 整条消息退回旧渲染，
 *        本轮所有思考被并成一块贴在顶部 —— 本 bug 的直接回归）
 *   [7] 并发流交错：别的流的正文 / 工具不切碎这条流的思考；本流换 step / 工具照常
 *       按阈值收口，think→tool→think 的交替保留
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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

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
/* 单行常量（数字 / 字符串，fnBody 的括号配平对它们会越界） */
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const dbSrc = read("renderer/app-db.js");

/* =====================================================================
 * [A] 抽真实实现（traceRunKey / traceNum / traceReset / traceOf / tracePush /
 *     traceText / traceThinkDisplay / stripToolLines / joinThinkText /
 *     traceThinkCloseIfBig / traceCloseThink）
 * ===================================================================== */
const S = {};
const sandbox = { S, console };
vm.createContext(sandbox);
vm.runInContext(
  constLine(dbSrc, "THINK_TINY_CHARS") +
    "\n" +
    extract(dbSrc, [
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
      "stripToolLines",
      "traceThinkDisplay",
    ]),
  sandbox,
  { filename: "think-merge-extract.js" },
);
function G(name) {
  return vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);
}
console.log("[A] app-db.js 思考碎片合并：真实实现抽取");
const WANTED = [
  "THINK_TINY_CHARS",
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
  /* 正文段的收口出口（say-end / 换 turn / 换 step / 工具 / 报错都走它）：
     tracePush 依赖它，抽真实现时必须一并带上 */
  "traceCloseSay",
  "tracePush",
  "traceText",
  "traceThinkDisplay",
];
const missing = WANTED.filter((n) => G(n) === null || G(n) === undefined);
eqNum(missing.length, 0, "目标函数 / 常量全部抽到真实实现" + (missing.length ? "（缺 " + show(missing) + "）" : ""));
eqNum(typeof G("tracePush"), "function", "tracePush 是真函数");
eqNum(typeof G("joinThinkText"), "function", "joinThinkText 是真函数");
eqNum(typeof G("traceThinkCloseIfBig"), "function", "traceThinkCloseIfBig 是真函数");
const TINY = G("THINK_TINY_CHARS");
ok(typeof TINY === "number" && TINY > 0, "THINK_TINY_CHARS 是正数（得到 " + show(TINY) + "）");
has(dbSrc, "if (kind === \"think\") {", "合并闸只对 think 生效（源码原文）");
has(dbSrc, "function traceThinkCloseIfBig(", "边界收口抽成 traceThinkCloseIfBig（源码原文）");
has(
  dbSrc,
  "if (String(it.text || \"\").length < THINK_TINY_CHARS) return false;",
  "只有写够阈值的思考才在边界处收口（源码原文）",
);
has(dbSrc, "traceThinkCloseIfBig(tr);", "工具调用 / 换 step 处调用收口（源码原文）");
has(dbSrc, "let it = traceThinkOpenItem(tr);", "只并进当前仍开放、且同一条流的思考段（源码原文）");
has(
  dbSrc,
  "it.text = joinThinkText(it.text, body, sameStream);",
  "合并走 joinThinkText（源码原文）",
);
has(dbSrc, "(Number(it.toolSeq) || 0) === seq;", "同流判据 = 同一 step 且这条流自上次追加以来没插过工具（源码原文）");
has(
  dbSrc,
  "if (traceThinkEventSameStream(tr, e, turn, step)) traceCloseThink(tr);",
  "只有同一条流的正文才收口思考（源码原文）",
);
has(
  dbSrc,
  "if (String(body).trim() && traceThinkEventSameStream(tr, e, turn, step))",
  "只有同一条流的非空白正文才收口思考（源码原文）",
);
has(dbSrc, "function traceStreamKey(", "流键抽成 traceStreamKey（源码原文）");
has(dbSrc, "function traceThinkEventSameStream(", "同流判定抽成 traceThinkEventSameStream（源码原文）");
has(dbSrc, "return a + \"\\n\" + b;", "跨 step / 跨工具才插换行（源码原文）");
has(dbSrc, "if (sameStream) return a + b;", "同一条思考流的增量原样相接、不插任何字符（源码原文）");
has(dbSrc, "if (/\\s$/.test(a) || /^\\s/.test(b)) return a + b;", "接缝已有空白则不重复插（源码原文）");

/* 真实 tracePush 驱动：think 段 = items 里 k==='think' 的条目 */
function thinkSegs(runKey) {
  const tr = S.runTrace[G("traceRunKey")(runKey)];
  return (tr && tr.items ? tr.items : []).filter((it) => it.k === "think");
}
const thinkPush = (runKey, txt, ev) => G("tracePush")(runKey, "think", txt, ev || {});

/* ===== [1] 40 个碎片 → 段数下降、封闭段都够阈值、全文有序不丢 ===== */
console.log(
  "\n[1] 连续 40 个 15–60 字、step 递增的碎片 → 段数远小于 40，封闭段都够阈值，全文按序不丢",
);
const RK1 = "merge40";
G("traceReset")(RK1);
const frags = [];
for (let i = 0; i < 40; i++) {
  /* 每片 15–60 字（都 < 阈值），带序号便于校验顺序与完整性 */
  const len = 15 + ((i * 7) % 46);
  let s = "片段" + i + "-";
  while (s.length < len) s += "字";
  frags.push(s.slice(0, len));
  thinkPush(RK1, frags[i], { turn: 1, step: i + 1 });
}
const segs1 = thinkSegs(RK1);
ok(segs1.length < 40, "40 个碎片合并后段数显著下降（得到 " + segs1.length + " 段）");
ok(segs1.length >= 2, "不是全并成一坨（得到 " + segs1.length + " 段）");
ok(
  segs1.slice(0, -1).every((s) => s.text.length >= TINY),
  "除最后一段（仍开放）外每段都写够阈值才收口（没有「思考 · 8 字」的小块）",
);
const joined1 = G("traceThinkDisplay")(RK1, "");
const stripped1 = joined1.replace(/\s+/g, "");
ok(
  frags.every((f, i) => stripped1.indexOf(f.replace(/\s+/g, "")) >= 0),
  "全部碎片字符都出现在拼接全文里（不丢字）",
);
let pos = -1;
let ordered = true;
for (const f of frags) {
  const at = stripped1.indexOf(f.replace(/\s+/g, ""), pos + 1);
  if (at < 0) {
    ordered = false;
    break;
  }
  pos = at;
}
ok(ordered, "碎片在拼接全文里保持原顺序（不乱序）");
eqNum(
  stripped1,
  frags.map((f) => f.replace(/\s+/g, "")).join(""),
  "拼接全文 = 各碎片按序相接（无增删字）",
);
ok(joined1.indexOf("片段0-") < joined1.indexOf("片段39-"), "首片在前、末片在后");
ok(
  segs1.every((s) => !/\s{2,}/.test(s.text)),
  "每段内部没有连续空白（双空格 / 空行）",
);
eqNum(segs1.map((s) => s.text).join("\n\n"), joined1, "各段文本按序拼起来 = traceThinkDisplay");

/* ===================== [2] 够长才在边界处收口（保留交替） ===================== */
console.log("\n[2] ≥阈值 的思考在边界处收口另起；小块继续并入当前开放段");
const RK2 = "bigone";
G("traceReset")(RK2);
const bigA = "A".repeat(TINY + 20);
const bigB = "B".repeat(TINY + 20);
thinkPush(RK2, bigA, { turn: 1, step: 1 });
thinkPush(RK2, bigB, { turn: 1, step: 2 });
const segs2 = thinkSegs(RK2);
eqNum(segs2.length, 2, "两段都 ≥阈值 → 换 step 即收口，各起一段（不被并成一段）");
eqNum(segs2[0].text, bigA, "第一段就是第一块");
eqNum(segs2[1].text, bigB, "第二段是第二块（未被合并）");
eqNum(G("traceThinkDisplay")(RK2, ""), bigA + "\n\n" + bigB, "traceText 段间空行分隔，两块都在");

/* 长块收口后跟的小块：另起一段（开放），下一块长思考再把它吸进来 */
const RK2b = "bigmix";
G("traceReset")(RK2b);
thinkPush(RK2b, bigA, { turn: 1, step: 1 });
thinkPush(RK2b, "小尾巴", { turn: 1, step: 2 });
const segs2b = thinkSegs(RK2b);
eqNum(segs2b.length, 2, "长块已在边界收口 → 小块另起一段（只此一段短，不会成排）");
eqNum(segs2b[0].text, bigA, "长块原样保留");
eqNum(segs2b[1].text, "小尾巴", "小块单独一段");
thinkPush(RK2b, bigB, { turn: 1, step: 3 });
const segs2c = thinkSegs(RK2b);
eqNum(segs2c.length, 2, "后续长块并进还没写够的那段（不新增小块）");
eqNum(segs2c[1].text, "小尾巴\n" + bigB, "小块 + 长块在同一段里（换行分隔）");

/* ============ [3] 碎片跨 tool 合并；够长的思考在工具处收口（保留穿插） ============ */
console.log("\n[3] 过短思考跨 tool 段并回同一段；够长思考在工具处收口、保留 think→tool→think");
const RK3 = "toolcut";
G("traceReset")(RK3);
thinkPush(RK3, "工具前的短思考", { turn: 1, step: 1 });
G("tracePush")(RK3, "tool", "", { turn: 1, step: 1, callId: "call-1" });
thinkPush(RK3, "工具后的短思考", { turn: 1, step: 2 });
const segs3 = thinkSegs(RK3);
eqNum(segs3.length, 1, "跨 tool 段的过短思考并回同一段（不再散成多块）");
eqNum(segs3[0].text, "工具前的短思考\n工具后的短思考", "两段思考在同一段里，顺序不变（跨 step 用换行）");
const items3 = S.runTrace[G("traceRunKey")(RK3)].items;
eqArr(
  items3.map((it) => it.k),
  ["think", "tool"],
  "时间线是 think → tool（不再为碎片重复新增 think 段）",
);
eqNum(items3[1].callId, "call-1", "工具段的 callId 原样保留");
/* 两段都够长 → 工具前后各自成段，穿插工具调用的时间线保留 */
const RK3d = "toollong";
G("traceReset")(RK3d);
thinkPush(RK3d, bigA, { turn: 1, step: 1 });
G("tracePush")(RK3d, "tool", "", { turn: 1, step: 1, callId: "call-9" });
thinkPush(RK3d, bigB, { turn: 1, step: 2 });
eqNum(thinkSegs(RK3d).length, 2, "两段都 ≥阈值 → 工具后仍另起一段");
const items3d = S.runTrace[G("traceRunKey")(RK3d)].items;
eqArr(
  items3d.map((it) => it.k),
  ["think", "tool", "think"],
  "够长的思考与工具调用交替（允许穿插，不再粘成一坨）",
);
eqNum(items3d[0].text, bigA, "工具前那段思考保持独立");
eqNum(items3d[2].text, bigB, "工具后那段思考另起一段");
/* 换 turn → 收口另起，不并进上一轮 */
const RK3e = "turncut";
G("traceReset")(RK3e);
thinkPush(RK3e, "第一轮短思考", { turn: 1, step: 1 });
thinkPush(RK3e, "第二轮短思考", { turn: 2, step: 1 });
eqNum(thinkSegs(RK3e).length, 2, "换 turn → 思考收口，另起一段");
/* say / err 段同样收口：中间夹了 say / err，思考也不得并回工具前那段 */
const RK3b = "saycut";
G("traceReset")(RK3b);
thinkPush(RK3b, "第一小段", { turn: 1, step: 1 });
G("tracePush")(RK3b, "say", "正文", { turn: 1, step: 1 });
thinkPush(RK3b, "第二小段", { turn: 1, step: 2 });
eqNum(thinkSegs(RK3b).length, 2, "中间夹 say → 两段 think 不合并");
const RK3c = "errcut";
G("traceReset")(RK3c);
thinkPush(RK3c, "前小段", { turn: 1, step: 1 });
G("tracePush")(RK3c, "err", "出错了", { turn: 1, step: 1 });
thinkPush(RK3c, "后小段", { turn: 1, step: 2 });
eqNum(thinkSegs(RK3c).length, 2, "中间夹 err → 两段 think 不合并");
/* 纯空白 say（适配器在思考之间夹的换行增量）不算「开口」，不阻断合并 */
const RK3f = "blanksay";
G("traceReset")(RK3f);
thinkPush(RK3f, "前半小段", { turn: 1, step: 1 });
G("tracePush")(RK3f, "say", "\n", { turn: 1, step: 1 });
thinkPush(RK3f, "后半小段", { turn: 1, step: 2 });
const segs3f = thinkSegs(RK3f);
eqNum(segs3f.length, 1, "中间夹纯空白 say → 两段 think 仍合并");
eqNum(segs3f[0].text, "前半小段\n后半小段", "纯空白 say 不打断、不丢字");

/* ===================== [4] 接缝不插多余字符 ===================== */
console.log("\n[4] 同一条思考流原样相接（不插空格）；跨段才插换行");
const jt = G("joinThinkText");
eqNum(jt("a", "b", true), "ab", "同一 turn/step 的流式增量：原样相接（一个字符都不插）");
eqNum(jt("a", "b", false), "a\nb", "跨 turn/step / 跨工具：插一个换行");
eqNum(jt("a ", "b", true), "a b", "同流且接缝左侧已有空格 → 原样相接");
eqNum(jt("a", " b", true), "a b", "同流且接缝右侧已有空格 → 原样相接");
eqNum(jt("a\n", "b", false), "a\nb", "跨段且接缝左侧已有换行 → 原样相接");
eqNum(jt("a", "\nb", false), "a\nb", "跨段且接缝右侧已有换行 → 原样相接");
eqNum(jt("a ", " b", true), "a  b", "两侧都有空白 → 保留既有空白（不额外加）");
eqNum(jt("", "b", true), "b", "空前缀 → 直接取后段");
eqNum(jt("a", "", true), "a", "空后段 → 保留前段");
/* 真实 tracePush 路径：碎片自带首尾空白时接缝不重复插 */
const RK4 = "seam";
G("traceReset")(RK4);
thinkPush(RK4, "前半段 ", { turn: 1, step: 1 });
thinkPush(RK4, "后半段", { turn: 1, step: 2 });
const segs4 = thinkSegs(RK4);
eqNum(segs4.length, 1, "自带尾部空白的碎片仍并入同一段");
eqNum(segs4[0].text, "前半段 后半段", "接缝只有一个空格（不因合并多插一个）");
ok(!/\s{2,}/.test(segs4[0].text), "真实路径也不产生双空格");
/* 跨 step 且两侧无空白 → 一个换行 */
const RK4b = "seamnl";
G("traceReset")(RK4b);
thinkPush(RK4b, "上一段", { turn: 1, step: 1 });
thinkPush(RK4b, "下一段", { turn: 1, step: 2 });
eqNum(thinkSegs(RK4b)[0].text, "上一段\n下一段", "跨 step 接缝用换行拼接");
/* 同一 step 内的逐块增量：原样相接（「字符间被插入空格」的直接回归） */
const RK4c = "seamsp";
G("traceReset")(RK4c);
thinkPush(RK4c, "同一", { turn: 1, step: 1 });
thinkPush(RK4c, "步内", { turn: 1, step: 1 });
thinkPush(RK4c, "的增量", { turn: 1, step: 1 });
eqNum(thinkSegs(RK4c)[0].text, "同一步内的增量", "同一 step 内逐块增量原样相接（不插空格）");
/* 同一 step 内插了工具调用 → 换行分隔，不把两段粘死 */
const RK4d = "seamtool";
G("traceReset")(RK4d);
thinkPush(RK4d, "调工具前", { turn: 1, step: 1 });
G("tracePush")(RK4d, "tool", "", { turn: 1, step: 1, callId: "t1" });
thinkPush(RK4d, "调工具后", { turn: 1, step: 1 });
eqNum(
  thinkSegs(RK4d)[0].text,
  "调工具前\n调工具后",
  "同一 step 里插了工具 → 换行分隔（不误当同一条流粘死）",
);

/* ===================== [5] traceThinkDisplay 完整文本 ===================== */
console.log("\n[5] traceThinkDisplay 返回完整文本");
const RK5 = "display";
G("traceReset")(RK5);
thinkPush(RK5, "第一段思考", { turn: 1, step: 1 });
thinkPush(RK5, "第二段思考", { turn: 1, step: 2 });
const disp = G("traceThinkDisplay")(RK5, "回退文本");
ok(disp.indexOf("第一段思考") >= 0 && disp.indexOf("第二段思考") >= 0, "两段内容都在返回文本里");
eqNum(G("traceText")(RK5, "think"), disp, "traceThinkDisplay = traceText('think')");
eqNum(G("traceThinkDisplay")("no-such-run", "回退文本"), "回退文本", "无轨迹时回退到调用方给的旧缓冲");
/* 合并只影响段数，say / err 口径不动 */
const RK5b = "sayintact";
G("traceReset")(RK5b);
thinkPush(RK5b, "思", { turn: 1, step: 1 });
G("tracePush")(RK5b, "say", "正文一", { turn: 1, step: 1 });
G("tracePush")(RK5b, "say", "正文二", { turn: 1, step: 1 });
eqNum(G("traceText")(RK5b, "say"), "正文一正文二", "say 续写口径未变（同段直接相接）");

/* ============ [6] 收尾落盘只夹单段字数：think / say / err / tool 段全保留、顺序不变 ============ */
console.log("\n[6] agentSegsForDisk 只夹单段字数：全部段保留，思考与工具都留在时间线原位");
const asSrc = read("renderer/app-assist.js");
has(asSrc, "function agentSegsForDisk(segList) {", "段数取舍收口在 agentSegsForDisk（源码原文）");
ok(
  asSrc.indexOf("AGENT_SEG_TOOL_MAX") < 0 && asSrc.indexOf("agentSegsTrimCap") < 0,
  "工具段条数上限口径已删净（段一裁，工具 chip 就掉到消息尾部压住最终回复）",
);
const sb2 = { console };
vm.createContext(sb2);
vm.runInContext(
  constLine(asSrc, "AGENT_SEG_TEXT_MAX") +
    "\n" +
    extract(asSrc, ["agentSegsForDisk", "dshMsgSegsViewable"]),
  sb2,
  { filename: "segs-for-disk-extract.js" },
);
const G2 = (n) =>
  vm.runInContext("(typeof " + n + " === 'undefined' ? null : " + n + ")", sb2);
/* 形状：1 段思考 + 45 个工具段 + 末尾 1 段正文 → 一条不丢、顺序不变 */
const many = [{ k: "think", text: "一整轮的思考", step: 1 }];
for (let i = 1; i <= 45; i++)
  many.push({ k: "tool", text: "", step: i, callId: "c" + i });
many.push({ k: "say", text: "最终回答", step: 46 });
const trimmed = G2("agentSegsForDisk")(many);
eqNum(trimmed.length, many.length, "46 条段一条不丢（旧口径会把 45 个工具段夹到 40）");
eqNum(
  trimmed.filter((s) => s.k === "tool").length,
  45,
  "45 个工具段全部保留（每颗 chip 都配得上自己的时间线位置）",
);
ok(
  trimmed.some((s) => s.k === "think"),
  "思考段没有被上限顶掉（旧口径「只留最后 N 段」会先丢它 → 一轮跑完思考消失）",
);
eqNum(trimmed[0].k, "think", "思考段仍在时间线最前，顺序不变");
eqNum(
  trimmed[trimmed.length - 1].text,
  "最终回答",
  "正文段照旧在整条消息末尾（AI 最终回复仍是最后那条内容）",
);
/* 旧口径的现场（就是本 bug）：长任务常有上百个 think / tool 段 —— 段一被裁，
   工具 chip 就只能从消息尾部冒出来（压在最终回复下方）；现在只夹单段字数。 */
const real = [];
for (let i = 1; i <= 60; i++) {
  real.push({ k: "think", text: "第 " + i + " 步思考（≥阈值的一段）", step: i });
  real.push({ k: "tool", text: "", step: i, callId: "call-" + i });
}
real.push({ k: "say", text: "最终回答", step: 61 });
const keptReal = G2("agentSegsForDisk")(real);
eqNum(
  keptReal.filter((s) => s.k === "think").length,
  60,
  "60 段思考全保留（不再被段数上限顶掉、也不截断）",
);
eqNum(
  keptReal.filter((s) => s.k === "say").length,
  1,
  "正文段保留（丢了它整条消息就退回旧渲染 → 思考并成一块）",
);
eqNum(
  keptReal.filter((s) => s.k === "tool").length,
  60,
  "60 个工具段全保留（不再被夹到 40 → 没有 chip 掉到消息尾部）",
);
eqNum(
  keptReal.map((s) => s.k).join(","),
  real.map((s) => s.k).join(","),
  "整条时间线的段序与运算前逐位一致（不重排、不丢段）",
);
const msgReal = { role: "assistant", content: "最终回答", segments: keptReal };
ok(
  G2("dshMsgSegsViewable")(msgReal),
  "落盘后仍按段渲染 → 一轮跑完思考留在原位（本 bug 的直接回归）",
);
/* 条数不设限；单段字数上限只夹 say / err（think 全保留） */
const manySays = [];
for (let i = 0; i < 45; i++) manySays.push({ k: "say", text: "s" + i, step: i });
const trimmed2 = G2("agentSegsForDisk")(manySays);
eqNum(trimmed2.length, 45, "正文段不受条数约束（全保留）");
eqNum(trimmed2[trimmed2.length - 1].text, "s44", "最后一段正文照旧在末尾");
/* 可还原性不受影响：裁剪后正文拼接仍等于 content 时历史渲染照样走分段 */
const msg6 = { role: "assistant", content: "最终回答", segments: trimmed };
ok(G2("dshMsgSegsViewable")(msg6), "裁剪后仍可分段渲染（思考块随之显示出来）");
/* 思考段落盘不截断（需求：一轮结束后不要自动隐藏 / 删除思考） */
const SEG_MAX = G2("AGENT_SEG_TEXT_MAX");
const bigThink = { k: "think", text: "思".repeat(SEG_MAX + 500), step: 1 };
const keptBig = G2("agentSegsForDisk")([bigThink, { k: "say", text: "正文", step: 2 }]);
const keptThink = keptBig.find((s) => s.k === "think");
eqNum(keptThink.text.length, SEG_MAX + 500, "思考段不按 say 的上限截断（正文才截）");
has(dbSrc, "if (it.k !== \"think\") {", "traceSegmentsOf 只对 say / err 设预算（源码原文）");
has(asSrc, "if (s.k !== \"think\" && text.length > AGENT_SEG_TEXT_MAX)", "agentSegsForDisk 不裁思考（源码原文）");
has(asSrc, "function agentCarryThinkOpenState(", "收尾把展开的思考状态带到历史消息（源码原文）");
has(asSrc, "agentCarryThinkOpenState(st, msg, rk);", "收尾消息落盘后调用状态搬运（源码原文）");

/* ===== [7] 并发流交错：别的流的正文 / 工具不切碎这条流的思考 ===== */
console.log("\n[7] 并发流（子代理 / 续跑轮）交错到达：另一条流的正文不再把思考切碎");
const RK7 = "interleave";
G("traceReset")(RK7);
/* 真实形状（见本机会话存档）：主 agent 在 step 6 逐步思考，子代理正文在 step 19 穿插 */
const frag7 = [];
for (let i = 0; i < 20; i++) {
  frag7.push("思" + i + "考");
  thinkPush(RK7, "思" + i + "考", { turn: 1, step: 6 });
  G("tracePush")(RK7, "say", "子代理正文" + i, { turn: 1, step: 19 });
}
const segs7 = thinkSegs(RK7);
eqNum(segs7.length, 1, "另一条流的正文穿插 20 次 → 思考仍是一段（旧口径每次 say 都切一段）");
eqNum(segs7[0].text, frag7.join(""), "同一条流的碎片原样相接（不插空格、不插换行）");
ok(
  segs7[0].open === true && segs7[0].text.length < 2 * TINY,
  "整段保持开放、碎片继续并进来（没有按每条外流正文切成 20 段）",
);
/* 带会话 id：另一条流哪怕同一步说话也不收口本流思考段 */
const RK7b = "sidsplit";
G("traceReset")(RK7b);
thinkPush(RK7b, "主代理思考一", { turn: 1, step: 1, sid: "A" });
G("tracePush")(RK7b, "say", "子代理正文", { turn: 1, step: 1, sid: "B" });
thinkPush(RK7b, "主代理思考二", { turn: 1, step: 1, sid: "A" });
eqNum(thinkSegs(RK7b).length, 1, "带会话 id：另一条流同一步的正文不切碎本流思考");
eqNum(thinkSegs(RK7b)[0].text, "主代理思考一主代理思考二", "同一条流的增量原样相接");
/* 另一条流的工具调用同样不收口；本流自己的才在够长时收口 */
const RK7c = "sidtool";
G("traceReset")(RK7c);
thinkPush(RK7c, "A".repeat(TINY + 5), { turn: 1, step: 1, sid: "A" });
G("tracePush")(RK7c, "tool", "", { turn: 1, step: 1, callId: "tB", sid: "B" });
ok(thinkSegs(RK7c)[0].open === true, "另一条流的工具调用不收口本流思考段");
G("tracePush")(RK7c, "tool", "", { turn: 1, step: 1, callId: "tA", sid: "A" });
ok(thinkSegs(RK7c)[0].open === false, "本流自己的工具调用才在够长时收口（保留交替）");
thinkPush(RK7c, "B".repeat(10), { turn: 1, step: 2, sid: "A" });
eqNum(thinkSegs(RK7c).length, 2, "收口后本流的下一段思考另起一块");
/* 交错场景里本流换 step：够长才收口，保证 think→tool→think 的交替仍在 */
const RK7d = "interstepp";
G("traceReset")(RK7d);
thinkPush(RK7d, "A".repeat(TINY + 5), { turn: 1, step: 6 });
G("tracePush")(RK7d, "say", "另一条流的正文", { turn: 1, step: 19 });
thinkPush(RK7d, "A".repeat(TINY + 5), { turn: 1, step: 7 });
eqNum(thinkSegs(RK7d).length, 2, "同一流换 step 且已够长 → 收口另起（穿插交替保留）");
/* 两条流都在思考且交错到达：宁可并进同一段，也绝不每块断一段 */
const RK7f = "sidboth";
G("traceReset")(RK7f);
thinkPush(RK7f, "主一", { turn: 1, step: 1, sid: "A" });
thinkPush(RK7f, "子一", { turn: 1, step: 3, sid: "B" });
thinkPush(RK7f, "主二", { turn: 1, step: 1, sid: "A" });
thinkPush(RK7f, "子二", { turn: 1, step: 3, sid: "B" });
const segs7f = thinkSegs(RK7f);
eqNum(segs7f.length, 1, "两条流交错思考 → 仍是一段（老网关分不清流时也不许碎成一块块）");
ok(
  segs7f[0].text.indexOf("主一") >= 0 &&
    segs7f[0].text.indexOf("主二") >= 0 &&
    segs7f[0].text.indexOf("子一") >= 0 &&
    segs7f[0].text.indexOf("子二") >= 0,
  "四条碎片都在同一段里，顺序不乱、不丢字",
);
/* 无会话 id 时退化成「按步分流」：同一步的正文仍算同一条流，正常收口 */
const RK7e = "nosid";
G("traceReset")(RK7e);
thinkPush(RK7e, "思考一", { turn: 1, step: 1 });
G("tracePush")(RK7e, "say", "正文", { turn: 1, step: 1 });
thinkPush(RK7e, "思考二", { turn: 1, step: 2 });
eqNum(thinkSegs(RK7e).length, 2, "无会话 id：同一步的正文照常收口（普通单流行为不变）");

/* ---------- 收尾 ---------- */
console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
process.exit(fails ? 1 : 0);
