"use strict";
/* systemPrompt 分节差分装配（对标 Codex WorldState 分节 + render_diff）
 *   node test/smoke-systemprompt-sections.js
 * 套路同 test/smoke-wire-drop-menu.js / test/smoke-resume-on-retry.js：用 vm 从 renderer 源码里
 * 按名字（或按真实源码区间）抠出**真代码**来跑，不起模型、不拉网关子进程。
 *   · 内核：整份 renderer/app-prompt-sections.js 求值（它零依赖），并交叉验证「按名字单独抠出来也能跑」
 *   · 会话 / 智能节点链：把 app-db.js dshRunOnce 里真实那一段（resumeRound → promptRender）连
 *     buildSections 的字面量一起抠进同一个 vm 上下文跑。七段片段的**顺序与取值表达式来自源文件本身**，
 *     「改造前的写法」由同一份字面量还原成 filter(Boolean).join("\n\n")；只有需要读 DOM / 配置的
 *     注记函数（agentDbGroundingNote 等）换成脚本化替身。
 *   · 助手链：同理抠 app-assist.js 里 scopeCurrent → systemPrompt 那一整段真实代码（本轮 Token 去重后仍约 2.5K 字符：规则段只留行为纪律，
 *     参数机制交给工具描述与内置技能），再与「九段直接串接」的历史写法逐字节比对。
 *   · 同一组用例的多轮之间复用同一个 context —— 分节快照表挂在 context 的 globalThis 上，
 *     换了 context 就等于换了进程。
 *
 * 覆盖（计划里锁定的四条）：
 *   [A] 内核：节序表 / 哈希 / buildSections 排序·合并·丢空 / renderSections 快照·裁剪·失效·计量
 *   [B] 会话·智能节点链：② 逐字节等价（nodeLock × 计划模式）＋ ① 同输入两轮只出变化节 ＋
 *       ③ 配置指纹变（换 model / 换工具许可）→ 全量重发 ＋ ④ pure 轮与续跑轮永远全量
 *   [C] 助手链：② 逐字节等价（scopeCurrent × assistAuto 四组合 + 内核缺失兜底）＋ ① app_state 单独重注
 *   [D] 接线与降级：脚本加载顺序、多出的 sectionCache 字段老网关忽略即保底、技能索引口径没跑偏 */
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
/* 长文本比对专用：命中就只报字符数，不命中只报「第几个字符起分叉」，
   绝不把整份系统提示（数千字符 × 4 组合）打进测试输出里 */
function longDiff(a, b) {
  const s = String(a);
  const t = String(b);
  const n = Math.min(s.length, t.length);
  let i = 0;
  while (i < n && s.charAt(i) === t.charAt(i)) i++;
  return (
    "（第 " + i + " 个字符起分叉：得到 " + show(s.slice(i, i + 48)) + " / 期望 " +
    show(t.slice(i, i + 48)) + "；长度 " + s.length + " vs " + t.length + "）"
  );
}
function eqNum(a, b, msg) {
  checks++;
  const long = typeof a === "string" && (charLen(a) > 60 || charLen(b) > 60);
  if (a === b) {
    console.log("  ok    " + msg + (long ? "（逐字节相同，" + charLen(a) + " 字符）" : "（得到 " + show(a) + "，期望 " + show(b) + "）"));
    return;
  }
  fails++;
  console.log("FAIL  " + msg + (long ? longDiff(a, b) : "（得到 " + show(a) + "，期望 " + show(b) + "）"));
}
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const countOf = (src, re) => (src.match(re) || []).length;
const charLen = (s) => String(s == null ? "" : s).length;

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
    /* 含函数头（只取花括号块会留下裸 return，语法不合法） */
    return src.slice(at, balancedEnd(src, i));
  }
  /* 数组 / 对象常量：按括号配平整块取出（多行常量按行取会被截断） */
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  return src.slice(at, balancedEnd(src, start)) + ";";
}
/* 从 src[start] 的开括号起配平，返回配平结束处的下标（跳过字符串与 // 、块注释） */
function balancedEnd(src, start) {
  const open = src[start];
  const close = { "[": "]", "{": "}", "(": ")" }[open];
  if (!close) throw new Error("不是开括号：" + show(open) + " @" + start);
  let depth = 0;
  let inStr = null;
  for (let j = start; j < src.length; j++) {
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
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return j + 1;
    }
  }
  throw new Error("括号未配平 @" + start);
}
const balancedAt = (src, start) => src.slice(start, balancedEnd(src, start));
/* 单行常量（字符串里没有括号时 fnBody 的配平会越界，只能按行取） */
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");
/* 真实源码区间切片：锚点必须全文件唯一命中，否则视为漂移（绝不静默切错段） */
function slice(src, startNeedle, endNeedle, label) {
  const hits = (n) => src.split(n).length - 1;
  eqNum(hits(startNeedle), 1, label + "：起点锚在源文件里唯一");
  eqNum(hits(endNeedle), 1, label + "：终点锚在源文件里唯一");
  const a = src.indexOf(startNeedle);
  const b = a < 0 ? -1 : src.indexOf(endNeedle, a);
  ok(b > a, label + "：起点在终点之前（区间非空）");
  if (a < 0 || b <= a) throw new Error(label + "：源码区间锚点丢失");
  return src.slice(a, b);
}

const kernelSrc = read("renderer/app-prompt-sections.js");
const dbSrc = read("renderer/app-db.js");
const assistSrc = read("renderer/app-assist.js");
const agentSrc = read("renderer/app-agent.js");
const gwSrc = read("dsh/gateway/gateway.mjs");
const mainDshSrc = read("dsh/main-dsh.js");
const preloadSrc = read("preload.js");
const indexHtml = read("renderer/index.html");

/* 每个 context 自带一份 __mtnodePromptSections 快照表 → 互不污染，等价于两个独立进程 */
function newCtx(props) {
  const sandbox = Object.assign({ console }, props || {});
  vm.createContext(sandbox);
  return sandbox;
}
const gv = (ctx, name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", ctx);
function fnProxy(ctx) {
  return new Proxy(
    {},
    {
      get: (_t, k) => {
        const s = String(k);
        if (s === "then" || s === "catch" || s === Symbol.toStringTag) return undefined;
        return gv(ctx, s);
      },
    },
  );
}
const loadKernel = (ctx) => {
  vm.runInContext(kernelSrc, ctx, { filename: "app-prompt-sections.js" });
  return fnProxy(ctx);
};
/* 真实的配置指纹函数（分节快照的准入条件）+ 它依赖的 dbHash */
const DB_SIG_FNS = ["dbHash", "dshRunSigOf"];
const loadSigFns = (ctx) =>
  vm.runInContext(extract(dbSrc, DB_SIG_FNS), ctx, { filename: "app-db-sig-extract.js" });

/* =====================================================================
 * [A] 内核结构（真实函数）
 * ===================================================================== */
console.log("\n[A] 内核 app-prompt-sections.js（整份真实文件求值）");
const ctxK = newCtx();
const K = loadKernel(ctxK);
const K_NAMES = [
  "promptSectionStore",
  "promptSectionHash",
  "promptSectionRank",
  "buildSections",
  "invalidatePromptSections",
  "promptSectionSnapshot",
  "setPromptSectionDiff",
  "promptSectionDiffEnabled",
  "promptSectionStats",
  "renderSections",
  "promptSectionCatalog",
];
eqArr(
  K_NAMES.filter((n) => typeof gv(ctxK, n) !== "function"),
  [],
  "内核目标函数全部抽到真实实现",
);
const ORDER = gv(ctxK, "PROMPT_SECTION_ORDER");
const IDS = gv(ctxK, "PROMPT_SECTION_IDS");
/* 任务书对齐 Codex WorldState 的那 12 节必须都在表里，且 id 拼写一个不差 */
const CORE_12 = [
  "persona_host",
  "scope",
  "canvas_rules",
  "superconnect_rules",
  "devnode_rules",
  "app_state",
  "skill_index",
  "db_grounding",
  "tool_policy",
  "node_capability",
  "plan_mode",
  "lang_taste",
];
eqArr(
  CORE_12.filter((id) => ORDER.indexOf(id) < 0),
  [],
  "12 个核心分节 id 全部在规范节序表里",
);
eqArr(
  CORE_12.filter((id) => IDS[id] !== id),
  [],
  "PROMPT_SECTION_IDS 的值 = id 本身（调用点不必手拼字符串）",
);
eqNum(ORDER[ORDER.length - 1], "lang_taste", "lang_taste 钉在末位（紧贴上下文尾部最容易被照做）");
eqNum(new Set(ORDER).size, ORDER.length, "节序表无重复 id");
ok(K.promptSectionCatalog() !== ORDER, "promptSectionCatalog 返回拷贝（改不动真表）");
eqArr(K.promptSectionCatalog(), ORDER, "catalog 内容与节序表一致");

/* 内容哈希：确定性 + 与 app-db.js 的 dbHash 同算法（文件头承诺的口径） */
const ctxH = newCtx();
vm.runInContext(extract(dbSrc, ["dbHash"]), ctxH, { filename: "dbHash-extract.js" });
const H = fnProxy(ctxH);
const SAMPLES = [
  "",
  "你是 MTNode 画布上的智能会话助手。",
  "- mtnode_vision：识图子代理\n",
  JSON.stringify({ nodes: [{ id: "a", kind: "proc_text" }], n: 42 }),
];
ok(
  SAMPLES.every((s) => K.promptSectionHash(s) === H.dbHash(s)),
  "promptSectionHash 与 app-db.js 的 dbHash 逐位同算法（技能索引暴露的哈希可直接比对）",
);
eqNum(K.promptSectionHash("分节内容"), K.promptSectionHash("分节内容"), "同内容同哈希（可重复）");
ok(
  K.promptSectionHash("分节内容 A") !== K.promptSectionHash("分节内容 B"),
  "内容差一个字符 → 哈希必变（差一个字也必须整节重发）",
);

/* buildSections：排序 / 同 id 合并 / 丢空 / 表外 id */
eqArr(
  K.buildSections({ lang_taste: "L", persona_host: "P", skill_index: "S" }).map((s) => s.id),
  ["persona_host", "skill_index", "lang_taste"],
  "对象入参按规范节序重排（而不是键序）",
);
eqArr(
  K.buildSections([
    { id: "tool_policy", text: "a" },
    { id: "scope", text: "s" },
    { id: "tool_policy", text: "b" },
  ]).map((s) => s.id + "=" + s.text),
  ["scope=s", "tool_policy=a\n\nb"],
  "同 id 多次出现按出现顺序合并（整表仍按规范节序）",
);
eqArr(
  K.buildSections({ scope: "s", zzz_custom: "z" }).map((s) => s.id),
  ["scope", "zzz_custom"],
  "表外 id 排到末尾且不丢内容",
);
eqArr(
  K.buildSections([
    { id: "scope", text: "" },
    { id: "plan_mode", text: null },
    { id: "lang_taste", text: " " },
  ]).map((s) => s.id),
  ["lang_taste"],
  "只丢 null / 空串（与历史 .filter(Boolean) 同口径），空白串照旧保留",
);
eqArr(
  K.buildSections({ scope: "S" }).map((s) => s.hash),
  [K.promptSectionHash("S")],
  "buildSections 顺手把内容哈希算好",
);

/* renderSections：出厂全量 → 跨轮裁剪 → 失效 → 计量 */
const mk = (pairs) => pairs.map(([id, text]) => ({ id, text }));
const FULL_AB = mk([
  ["persona_host", "宿主人设长文——".repeat(4)],
  ["skill_index", "【MTNode 内置技能索引】摘要摘要摘要"],
  ["lang_taste", "【语言口味】中文（简体）"],
]);
const fullTextOf = (list, join) => list.map((s) => s.text).join(join == null ? "\n\n" : join);
K.invalidatePromptSections();
eqNum(K.promptSectionDiffEnabled(), false, "diff 出厂关闭（现网下发的那份系统提示必须自洽完整）");
const r1 = K.renderSections("kA", FULL_AB, { sig: "sig1" });
eqNum(r1.text, fullTextOf(FULL_AB), "默认全量渲染 = 按节序以空行拼接（逐字节等价的地基）");
eqArr(r1.dropped, [], "全量渲染不裁任何节");
eqNum(r1.savedChars, 0, "全量渲染省下 0 字符");
eqNum(r1.first, true, "首轮无快照 → first=true");
eqNum(r1.changed.length, 3, "首轮所有节都算变化节");
eqNum(r1.fullRender, true, "fullRender=true（本轮没启用裁剪）");
eqNum(r1.sectionCache.order.length, 3, "sectionCache 把节序一并带出（跨轮注入预留）");
eqNum(r1.sectionCache.diffAvailable, false, "sectionCache 如实报告本轮未启用裁剪");
const r2 = K.renderSections("kA", FULL_AB, { sig: "sig1" });
eqArr(
  r2.unchanged,
  ["persona_host", "skill_index", "lang_taste"],
  "同输入第二轮：三节全部命中上一轮哈希",
);
eqArr(r2.changed, [], "同输入第二轮 changed 为空");
ok(r2.first === false && r2.text === r1.text, "diff 关闭时第二轮仍全量下发（与改造前行为一致）");
const r3 = K.renderSections("kA", FULL_AB, { sig: "sig1", diff: true });
eqArr(
  r3.dropped,
  ["persona_host", "skill_index", "lang_taste"],
  "diff 打开后未变节整节被裁（这就是 Codex「不变 = 0 token」的口径）",
);
eqNum(r3.text, "", "未变节全裁 → 本轮下发空串");
/* 注记（现状锁定 · 不在本任务修复范围）：kept 为空时内核把 savedChars 记 0，
   而本轮真实省下的是整串长度。修这条口径时下面这行会亮，同步改 docs 即可。 */
eqNum(r3.savedChars, 0, "注记：整轮零节下发时 savedChars 记 0（计量缺口，见汇报与 docs）");
const CHANGED = mk([
  [FULL_AB[0].id, FULL_AB[0].text],
  [FULL_AB[1].id, "【MTNode 内置技能索引】摘要摘要摘要（技能库更新后变了）"],
  [FULL_AB[2].id, FULL_AB[2].text],
]);
const r4 = K.renderSections("kA", CHANGED, { sig: "sig1", diff: true });
eqArr(r4.changed, ["skill_index"], "只有一节内容变了 → changed 只含那一节");
eqArr(r4.dropped, ["persona_host", "lang_taste"], "未变的两节仍被裁");
eqNum(r4.text, CHANGED[1].text, "本轮只重注变化的那一节");
eqNum(
  r4.savedChars,
  fullTextOf(CHANGED).length - CHANGED[1].text.length,
  "savedChars 逐字节精确（全量应下发 − 实下发，含分隔符）",
);
const st4 = K.promptSectionStats("kA");
eqNum(st4.injected, 1, "stats.injected = 本轮真正注入的节数");
eqNum(st4.total, 3, "stats.total = 本轮分节总数");
eqArr(st4.dropped, r4.dropped, "stats.dropped 与出参一致（诊断日志取的就是它）");
const r5 = K.renderSections("kA", CHANGED, { sig: "other-sig", diff: true });
eqNum(r5.text, fullTextOf(CHANGED), "配置指纹变（sig 不符）→ 快照作废并整段全量重发");
eqArr(r5.dropped, [], "指纹变那一轮一节都不裁");
eqNum(r5.first, true, "指纹变 → 本轮无可用快照");
K.invalidatePromptSections();
const r6 = K.renderSections("kB", FULL_AB, { sig: "s", diff: true });
eqNum(r6.text, fullTextOf(FULL_AB), "点名失效后首轮必全量（没有快照就没有可省的依据）");
eqNum(K.invalidatePromptSections("kB"), 1, "invalidatePromptSections(runKey) 报清掉了那条快照");
eqNum(K.promptSectionSnapshot("kB"), null, "该 runKey 快照已空");
eqNum(K.invalidatePromptSections("kB"), 0, "再清一次返回 0（幂等）");
eqNum(K.promptSectionSnapshot("kC"), null, "未跑过的 runKey 无快照");
K.renderSections("kC", FULL_AB, { sig: "s", record: false });
eqNum(K.promptSectionSnapshot("kC"), null, "record:false 只渲染不写状态（预览 / 计量旁路）");
eqNum(K.promptSectionStats("kC"), null, "record:false 不写 stats");
eqNum(K.renderSections("kD", [], { sig: "s" }).text, "", "空分节表 → 空串");
eqNum(
  K.renderSections("kE", { scope: "A\n", app_state: "B\n" }, { sig: "s", join: "" }).text,
  "A\nB\n",
  "join:\"\" 复现助手长文的串接口径",
);
eqNum(
  K.renderSections("kE", { scope: "A\n", app_state: "X\n" }, { sig: "s", join: "", diff: true }).text,
  "X\n",
  "join:\"\" 时按节 diff 同样生效（app_state 变了只重注它）",
);

/* 按名字单独抠出来也要能跑（文件头承诺「便于 vm 按名字抠出来直接跑」） */
const ctxK2 = newCtx();
vm.runInContext(
  extract(kernelSrc, [
    "PROMPT_SECTION_ORDER",
    "PROMPT_SECTION_IDS",
    "promptSectionStore",
    "promptSectionHash",
    "promptSectionRank",
    "buildSections",
    "invalidatePromptSections",
    "promptSectionSnapshot",
    "setPromptSectionDiff",
    "promptSectionDiffEnabled",
    "promptSectionStats",
    "renderSections",
    "promptSectionCatalog",
  ]) + constLine(kernelSrc, "PROMPT_SECTION_JOIN"),
  ctxK2,
  { filename: "kernel-name-extract.js" },
);
const K2 = fnProxy(ctxK2);
ok(typeof K2.renderSections === "function", "renderSections 可按名字抠出单独跑");
eqNum(
  show(K2.renderSections("x", FULL_AB, { sig: "s" })),
  show(K.renderSections("x", FULL_AB, { sig: "s" })),
  "按名字抠出的内核与整份求值的内核结果逐字节相同（真函数，不是影子实现）",
);

/* =====================================================================
 * [B] 会话 / 智能节点链：app-db.js dshRunOnce 的真实装配段
 * ===================================================================== */
console.log("\n[B] 会话·智能节点链 app-db.js（真实源码区间 + 真实节序字面量）");
/* 片段替身：只替「要读 DOM / 配置」的注记函数，函数名与调用口径与源码一致 */
const FX = {
  persona: "你是 MTNode 画布上的智能会话助手。可读写文件、联网、执行命令。\n",
  indexBlock:
    "【MTNode 内置技能索引】仅摘要；匹配任务后再用 skill 工具读取完整 SKILL.md。\n\n[MTNode 产品与画布]\n- mtnode-grill-me | 拷问我 | 需求拷问…\n- mtnode-db-facts | 数据库事实查询纪律 | …\n",
  db: "【数据库】一切事实走 mtnode_db 工具，禁止用记忆补全。\n",
  tool: "【Agent 工具许可】当前预设「默认（当前能力）」。拒绝：识图子代理 (vision)。\n",
  toolChanged:
    "【Agent 工具许可】当前预设「精简」。拒绝：识图子代理 (vision)、联网搜索 (web_search)、改画布。\n",
  nodeCap: "【画布节点能力】你可 create/update/connect 当前画布节点。\n",
  plan: "【计划模式】先出 <!--MTNODE-PLAN--> 再执行。\n",
  lang: "【语言口味 · 交流语言】当前 MTNode 界面语言为中文（简体）。\n",
};
const NODE_IDS_EXPECTED = [
  "persona_host",
  "skill_index",
  "db_grounding",
  "tool_policy",
  "node_capability",
  "plan_mode",
  "lang_taste",
];
const nodeSlice = slice(dbSrc, "const resumeRound = ", "const runParams = {", "app-db.js 分节装配段");
has(nodeSlice, "buildSections(", "切到的区间里含 buildSections 调用");
has(nodeSlice, "renderSections(runKey, promptSections", "切到的区间里含 renderSections 调用");
/* 真实的七段字面量：从源文件原样抠出（节序与取值表达式由源文件说了算） */
const litAt = dbSrc.indexOf("buildSections([", dbSrc.indexOf("const promptSections = pureOn"));
const nodeLiteral = balancedAt(dbSrc, litAt + "buildSections(".length);
ok(nodeLiteral.indexOf("[") === 0 && nodeLiteral.indexOf("PROMPT_SECTION_IDS") > 0, "抠到 buildSections 的数组字面量");

/* ── 切片起点之前的真实局部量：按锚点把源文件那几行原样取来求值 ─────────────────
   装配段引用的 leanOn / noCanvasOn / noReadOn / dbGrounding（app-db.js）与
   assistCanvasFree / assistLean / assistHide（app-assist.js）都定义在切片区间之前。
   以前在这里手抄一份「夹具值」= 影子实现：源文件加一个局部量（这轮的 noReadOn）或改一行
   判据，测试就 ReferenceError、甚至悄悄测的是旧逻辑。现在取值仍走源文件原判据，
   锚点丢失就报漂移 —— 要替的只剩「读配置 / 读 DOM」的函数。 */
function decls(src, srcName, heads) {
  return heads
    .map((head) => {
      const a = src.indexOf(head);
      ok(a >= 0, srcName + " 里应能找到声明：" + head.trim());
      if (a < 0) return "";
      const b = src.indexOf(";", a);
      ok(b > a, head.trim() + " 是单语句（判据变大要回来改这里的切片口径）");
      return src.slice(a, b + 1);
    })
    .join("\n") + "\n";
}
const nodePrelude = decls(dbSrc, "app-db.js", [
  "const leanOn = ",
  "const canvasFreeOn = ",
  "const noCanvasOn = ",
  "const noReadOn = ",
  "const dbGrounding = ",
]);

/* 一个 env = 一个 vm 上下文（= 一个常驻进程的分节快照表）；run() 只改入参再跑真实那段 */
function makeNodeEnv(fixture) {
  const sandbox = {
    opts: fixture.opts,
    indexBlock: fixture.indexBlock,
    nodeLock: fixture.nodeLock,
    pureOn: fixture.pureOn,
    runKey: fixture.runKey,
    runSig: fixture.runSig,
    S: { wf: { nodes: [], wires: [] } },
    boundWf: { nodes: [], wires: [] },
    /* 设置里的「精简工具负载」：本测试按 fixture 给，其余全走源文件原判据 */
    dshLeanToolsOn: () => !!fixture.lean,
    agentDbGroundingNote: () => FX.db,
    agentToolPolicySystemNote: () => FX.tool,
    agentNodeCapabilityNote: () => FX.nodeCap,
    planModeSystemNote: () => FX.plan,
    agentLangTasteNote: () => FX.lang,
  };
  const ctx = newCtx(sandbox);
  const KK = loadKernel(ctx);
  loadSigFns(ctx);
  vm.runInContext(
    "globalThis.__evalLiteral = function () {\n" +
      nodePrelude +
      "\nreturn " + nodeLiteral + ";\n};\n" +
      "globalThis.__runAssemble = function () {\n" +
      nodePrelude +
      nodeSlice +
      "\nreturn { promptSections: promptSections, promptRender: promptRender };\n};",
    ctx,
    { filename: "app-db-section-assemble.js" },
  );
  return {
    ctx,
    K: KK,
    set(over) {
      /* 必须写回被 contextify 的那个对象（newCtx 的返回值）；改原 props 副本不会生效 */
      Object.assign(ctx, over || {});
    },
    literal() {
      return vm.runInContext("__evalLiteral()", ctx);
    },
    run(over) {
      this.set(over);
      return vm.runInContext("__runAssemble()", ctx);
    },
  };
}
/* 「改造前的写法」：同一份字面量的 text 按源文件顺序 filter(Boolean).join("\n\n") */
const oldFormula = (arr, join) =>
  arr
    .map((o) => o && o.text)
    .filter(Boolean)
    .join(join == null ? "\n\n" : join);
const nonEmptyIds = (arr) => arr.filter((o) => o && o.text).map((o) => o.id);

const cfgBase = {
  workspace: "E:/dev/ws",
  model: "deepseek-v4-flash",
  provider: "deepseek-official",
  preset: "standard",
  effort: "high",
  pure: false,
  maxTokens: 8192,
};
loadSigFns(ctxK);
const sigOf = (over) =>
  vm.runInContext("dshRunSigOf(" + show(Object.assign({}, cfgBase, over)) + ")", ctxK);
const sigA = sigOf({});
ok(!!sigA && sigA === sigOf({}), "dshRunSigOf 稳定（同一套配置指纹可重复）");
ok(sigOf({ model: "deepseek-v4-pro" }) !== sigA, "换 model → 配置指纹变");
ok(sigOf({ preset: "code" }) !== sigA, "换 preset → 配置指纹变");
ok(sigOf({ pure: true }) !== sigA, "pure 切换 → 配置指纹变");

/* ---- ② 逐字节等价：nodeLock × 计划模式 两态 ---- */
const nodeScenarios = [
  { name: "画布智能节点（nodeLock + 计划模式）", nodeLock: true, planMode: true },
  { name: "普通会话（无 node_capability / 无 plan_mode）", nodeLock: false, planMode: false },
];
for (const sc of nodeScenarios) {
  const opts = {
    systemPrompt: FX.persona,
    node: { id: sc.nodeLock ? "nodeLock" : "sess1", kind: sc.nodeLock ? "agent_task" : "proc_text" },
    planMode: sc.planMode,
    resumeSession: "",
  };
  const env = makeNodeEnv({
    opts,
    indexBlock: FX.indexBlock,
    nodeLock: sc.nodeLock,
    pureOn: false,
    runKey: "rk-" + (sc.nodeLock ? "node" : "sess"),
    runSig: sigA,
  });
  const arr = env.literal();
  eqArr(
    arr.map((o) => o.id),
    NODE_IDS_EXPECTED,
    "源文件里的节序 = 历史七段顺序（id 一字不差）",
  );
  const ranks = arr.map((o) => ORDER.indexOf(o.id));
  ok(
    ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1])),
    sc.name + "：节序在规范节序表里严格递增 ⇒ 分节渲染不重排历史顺序",
  );
  const res = env.run();
  eqNum(res.promptRender.text, oldFormula(arr), sc.name + "：全量渲染与改造前逐字节一致");
  ok(charLen(res.promptRender.text) > 200, sc.name + "：样本非退化（真拼了 " + charLen(res.promptRender.text) + " 字符）");
  eqArr(
    Object.keys(res.promptRender.hashes),
    nonEmptyIds(arr),
    sc.name + "：hashes 的键 = 本轮非空节（空节不登记）",
  );
  eqArr(
    res.promptSections.map((s) => s.id),
    nonEmptyIds(arr),
    sc.name + "：buildSections 产出的节 = 非空片段（无重复、无丢失）",
  );
  eqNum(res.promptRender.dropped.length, 0, sc.name + "：默认口径不裁任何节");
  /* 宿主提示缺省（会话侧没带 systemPrompt）时也不该留空行 */
  const env2 = makeNodeEnv({
    opts: Object.assign({}, opts, { systemPrompt: "" }),
    indexBlock: FX.indexBlock,
    nodeLock: sc.nodeLock,
    pureOn: false,
    runKey: "rk-nopersona-" + (sc.nodeLock ? "node" : "sess"),
    runSig: sigA,
  });
  const arr2 = env2.literal();
  eqNum(
    env2.run().promptRender.text,
    oldFormula(arr2),
    sc.name + "：persona_host 为空时整节消失（等价旧的 filter(Boolean)）",
  );
  eqArr(
    nonEmptyIds(arr2),
    nonEmptyIds(arr).filter((id) => id !== "persona_host"),
    sc.name + "：空掉的只有 persona_host 一节",
  );
}

/* ---- ① + ③ 同输入两轮 / 变化节 / 指纹失效（同一 env 连跑多轮） ---- */
{
  const opts = {
    systemPrompt: FX.persona,
    node: { id: "agent:x", kind: "agent_task" },
    planMode: true,
    resumeSession: "",
  };
  const env = makeNodeEnv({
    opts,
    indexBlock: FX.indexBlock,
    nodeLock: true,
    pureOn: false,
    runKey: "rk-diff-node",
    runSig: sigA,
  });
  const full = oldFormula(env.literal());
  /* diff 是全局开关：调用点不传（出厂关）。这里打开它，验证「只重注变化节」的接口口径。 */
  env.K.setPromptSectionDiff(true);
  eqNum(env.K.promptSectionDiffEnabled(), true, "diff 开关可按 runKey 之外全局启用（接口预留）");
  const a1 = env.run().promptRender;
  eqNum(a1.text, full, "第 1 轮全量下发（无快照可省）");
  const a2 = env.run().promptRender;
  eqArr(a2.changed, [], "第 2 轮同输入 → changed 为空（没有任何节变化）");
  eqNum(a2.text, "", "第 2 轮未变的节全部可裁（协议升级后即 0 token）");
  /* 换工具许可：只有 tool_policy 一节内容变 */
  FX.tool = FX.toolChanged;
  const a3 = env.run().promptRender;
  eqArr(a3.changed, ["tool_policy"], "换工具许可 → changed 只含 tool_policy");
  eqArr(
    a3.dropped,
    ["persona_host", "skill_index", "db_grounding", "node_capability", "plan_mode", "lang_taste"],
    "其余六节仍被裁",
  );
  eqNum(a3.text, FX.toolChanged, "本轮只重注变化的那一节");
  eqNum(
    a3.savedChars,
    oldFormula(env.literal()).length - FX.toolChanged.length,
    "省下字符数 = 全量应下发 − 实下发（逐字节）",
  );
  /* 技能索引变了 → 只重注 skill_index（工具许可保持上一轮的值） */
  env.set({ indexBlock: FX.indexBlock + "\n- mtnode-new-skill | 新技能 | 新来的\n" });
  const a4 = env.run().promptRender;
  eqArr(a4.changed, ["skill_index"], "技能索引更新 → changed 只含 skill_index");
  eqNum(a4.text, FX.indexBlock + "\n- mtnode-new-skill | 新技能 | 新来的\n", "只重注索引那一节");
  /* ③ 配置指纹变（换 model）→ 快照失效全量重发 */
  const a5 = env.run({ runSig: sigOf({ model: "deepseek-v4-pro" }) }).promptRender;
  eqNum(a5.text, oldFormula(env.literal()), "换 model（指纹变）→ 整段全量重发，一节都不省");
  eqArr(a5.dropped, [], "指纹变那一轮不裁任何节");
  eqNum(a5.first, true, "指纹变 → 旧快照作废");
  const a6 = env.run({ runSig: sigOf({ model: "deepseek-v4-pro" }) }).promptRender;
  eqNum(a6.text, "", "新指纹下重建快照（同一套配置的下一轮才可裁）");
  env.K.setPromptSectionDiff(false);
  env.set({ indexBlock: FX.indexBlock });
  eqNum(env.run().promptRender.text, oldFormula(env.literal()), "diff 关回出厂值 → 又恢复逐字节全量下发");
}

/* ---- ④ pure 轮与续跑（retry）轮永远全量 ---- */
{
  const optsBase = {
    systemPrompt: FX.persona,
    node: { id: "agent:p", kind: "agent_task" },
    planMode: false,
    resumeSession: "",
  };
  const pureKey = "rk-pure";
  const envP = makeNodeEnv({
    opts: optsBase,
    indexBlock: FX.indexBlock,
    nodeLock: true,
    pureOn: false,
    runKey: pureKey,
    runSig: sigA,
  });
  envP.run();
  ok(envP.K.promptSectionSnapshot(pureKey) !== null, "pure 之前：该 runKey 有快照");
  const pr = envP.run({ pureOn: true, runSig: sigOf({ pure: true }) });
  eqArr(pr.promptSections, [], "pure 轮不构建任何分节（模型输入 = 纯粹的用户输入）");
  eqNum(pr.promptRender, null, "pure 轮不进内核 → runParams 走 systemPrompt 空串分支");
  eqNum(envP.K.promptSectionSnapshot(pureKey), null, "pure 轮作废该 runKey 快照（不许被当成可省的依据）");
  const pr2 = envP.run({ pureOn: false, runSig: sigA });
  eqNum(
    pr2.promptRender.text,
    oldFormula(envP.literal()),
    "pure 之后回到普通轮：仍全量下发（快照已没，绝不半份上下文）",
  );
  has(dbSrc, 'systemPrompt: pureOn ? "" : promptRender.text,', "pure 轮下发空串（源码那行未动）");
  has(dbSrc, "sectionCache: pureOn ? undefined : promptRender.sectionCache,", "pure 轮连指纹出参也不下发");

  /* 续跑轮（dshRunTask 那一轮 systemPrompt:""）：full:true → 永远全量 */
  const rsKey = "rk-resume";
  const envR = makeNodeEnv({
    opts: optsBase,
    indexBlock: FX.indexBlock,
    nodeLock: true,
    pureOn: false,
    runKey: rsKey,
    runSig: sigA,
  });
  envR.K.setPromptSectionDiff(true);
  envR.run();
  const fullAfter = oldFormula(envR.literal());
  eqNum(envR.run().promptRender.text, "", "对照：普通轮在 diff 下会被裁空");
  const rr = envR
    .run({ opts: Object.assign({}, optsBase, { systemPrompt: "", resumeSession: "session-abc" }) })
    .promptRender;
  const noPersona = oldFormula(envR.literal());
  ok(noPersona !== fullAfter, "续跑轮宿主人设一节为空（其余节照发）");
  eqNum(rr.text, noPersona, "续跑轮走全量旁路：其余节一字不裁地重发");
  eqArr(rr.dropped, [], "续跑轮不裁任何节（即使 diff 开着）");
  eqNum(rr.fullRender, true, "续跑轮如实报告本轮全量渲染");
  eqNum(rr.sectionCache.diffAvailable, false, "sectionCache 标记本轮不可裁剪");
  ok(envR.K.promptSectionSnapshot(rsKey) !== null, "续跑轮把新快照记回去（真正下发过的节才算发过）");
  envR.K.setPromptSectionDiff(false);
  has(dbSrc, 'systemPrompt: "",', "dshRunTask 重发轮仍发空 systemPrompt（源码那行未动）");
  eqNum(countOf(dbSrc, /systemPrompt: "",/g), 1, "全文件只有续跑那一处置空 systemPrompt");
}

/* =====================================================================
 * [C] 助手链：app-assist.js 的真实装配段（九段宿主长文 + 状态 JSON）
 * ===================================================================== */
console.log("\n[C] 助手链 app-assist.js（真实宿主长文 + 当前应用状态 JSON）");
const assistSlice = slice(
  assistSrc,
  "const canvasEditRule =",
  "let assistHitMaxTokens = false;",
  "app-assist.js 分节装配段",
);
has(assistSlice, "const scopeBlock =", "切到的区间含 scopeBlock（scopeCurrent 由夹具给）");
has(assistSlice, "renderSections(", "切到的区间含 renderSections 调用");
ok(assistSlice.indexOf("await") < 0, "切到的区间无 await（可在同步 vm 函数里跑真实那段）");
/* 助手侧切片起点之前的那一个真实局部量（Gate B 判据）同样按原句求值；
   assistLean / assistHide 已经在切片区间里，prelude 里再声明一次会撞 id。 */
const assistPrelude = decls(assistSrc, "app-assist.js", ["const assistCanvasFree = "]);
const ASSIST_IDS = [
  "persona_host",
  "scope",
  "canvas_rules",
  "superconnect_rules",
  "devnode_rules",
  "vision_media_rules",
  "layout_rules",
  "principle",
  "app_state",
];
const ASSIST_PARTS = [
  "personaHost",
  "scopeBlock",
  "canvasEditRule",
  "superConnectRule",
  "devNodeRule",
  "visionMediaRules",
  "layoutRules",
  "principleBlock",
  "appStateBlock",
];
const STATE_A = JSON.stringify({ workflow: "画布A", nodes: 12, view: { zoom: 1 } }, null, 2);
const STATE_B = JSON.stringify({ workflow: "画布A", nodes: 13, view: { zoom: 1 } }, null, 2);
/* app_state 节前那行纪律（「只给计数 + 选中 / 焦点，节点列表 / 正文按需 canvas_get」）也是本节的一部分；
   期望值直接从 app-assist.js 取，避免测试里再抄第二份文案。 */
const APP_STATE_HEAD = (() => {
  const m = assistSrc.match(/"((?:\\.|[^"\\])*本轮 app_state 只给(?:\\.|[^"\\])*)"/);
  return m ? JSON.parse('"' + m[1] + '"') : "";
})();
ok(
  APP_STATE_HEAD.indexOf("mtnode_canvas_get") >= 0,
  "app_state 节前有『只给计数 + 选中 / 焦点、列表与正文按需 canvas_get』一行纪律（diff 期望值以它为准）",
);
/* 一个 env = 一个上下文；改状态 JSON / 模型 / 范围档只动入参，跑的仍是源文件里那段真代码 */
function makeAssistEnv(fixture) {
  const fx = Object.assign(
    {
      stateJson: STATE_A,
      scopeCurrent: true,
      assistAuto: true,
      assistModel: "deepseek-v4-flash",
      noKernel: false,
    },
    fixture || {},
  );
  const S = {
    assistRunWorkspace: "E:/dev/ws",
    dshWorkspaceFallback: "E:/fallback",
    assistModel: fx.assistModel,
    assistProvider: "deepseek-official",
    assistPreset: "standard",
    assistEffort: "high",
    assistCanvasFree: !!fx.canvasFree,
    wf: { name: "画布A", nodes: [], wires: [] },
    config: { dsh: { assistAutoApprove: fx.assistAuto } },
  };
  const ctx = newCtx({
    /* 切片起点之前的四个真实局部量（scopeCurrent / wfName / assistAuto / stateJson）由夹具给 */
    scopeCurrent: fx.scopeCurrent,
    wfName: "画布A",
    assistAuto: fx.assistAuto,
    stateJson: fx.stateJson,
    hist: "",
    t: "帮我把这三张图连成批处理",
    skillWrap: null,
    skillTaskPrompt: () => "",
    dshRunMaxTokens: () => 8192,
    /* 读配置的替身：助手恒未接入数据库副本（名单真行为由 smoke-token-budget [9] 钉） */
    dshLeanToolsOn: () => !!fx.lean,
    dshHiddenToolsFor: () => ["mtnode_db"],
    AGENT_PRESET_DEFAULT: "minimal",
    I18n: { t: (s) => String(s) },
    S,
  });
  if (!fx.noKernel) {
    loadKernel(ctx);
    loadSigFns(ctx);
  }
  vm.runInContext(
    "globalThis.__runAssist = function () {\n" +
      assistPrelude +
      assistSlice +
      "\nreturn { systemPrompt: systemPrompt, assistSections: assistSections, parts: [" +
      ASSIST_PARTS.join(", ") +
      "] };\n};",
    ctx,
    { filename: "app-assist-section-assemble.js" },
  );
  return {
    ctx,
    run(over) {
      Object.assign(fx, (over && over.state) || {});
      if (over && over.s) Object.assign(S, over.s);
      ctx.scopeCurrent = fx.scopeCurrent;
      ctx.assistAuto = fx.assistAuto;
      ctx.stateJson = fx.stateJson;
      return vm.runInContext("__runAssist()", ctx);
    },
    js: (code) => vm.runInContext(code, ctx),
  };
}
for (const scopeCurrent of [true, false]) {
  for (const assistAuto of [true, false]) {
    const tag = (scopeCurrent ? "当前画布" : "全局") + "×" + (assistAuto ? "改画布批准" : "需确认");
    const res = makeAssistEnv({}).run({ state: { scopeCurrent, assistAuto } });
    const oldStr = res.parts.join("");
    eqNum(res.systemPrompt, oldStr, tag + "：助手 systemPrompt 与改造前逐字节一致（九段直接串接）");
    ok(charLen(oldStr) > 1200, tag + "：样本是真实长文（" + charLen(oldStr) + " 字符，去重后的九节宿主长文）");
    eqArr(res.parts.filter((p) => !p), [], tag + "：九节全部非空（若有空节，分节装配会丢段 → 与历史串接口径不同）");
    eqArr(Object.keys(res.assistSections), ASSIST_IDS, tag + "：assistSections 的键序 = 规范节序前 9 节");
    const ranks = ASSIST_IDS.map((id) => ORDER.indexOf(id));
    ok(
      ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1])),
      tag + "：九节在规范节序表里严格递增（节序即历史顺序）",
    );
    eqArr(
      Object.keys(res.assistSections).filter(
        (k) => ["skill_index", "db_grounding", "tool_policy", "lang_taste"].indexOf(k) >= 0,
      ),
      [],
      tag + "：技能索引 / 接地 / 工具许可 / 语言口味不在助手侧重复注入（仍由 app-db.js 追加）",
    );
  }
}
/* 内核缺失（老包 / 加载顺序被改坏）时的兜底分支必须等价 */
eqNum(
  makeAssistEnv({ noKernel: true }).run().systemPrompt,
  makeAssistEnv({}).run().systemPrompt,
  "内核不在时按同一节序直接串接兜底：结果与分节渲染逐字节一致",
);
/* ① 跨轮裁剪：只有每轮都变的 app_state 需要重发 */
{
  const env = makeAssistEnv({});
  const full = env.run().systemPrompt;
  eqNum(env.run().systemPrompt, full, "diff 关闭：助手第二轮仍全量下发（现网行为不变）");
  env.js("setPromptSectionDiff(true)");
  eqNum(env.run().systemPrompt, "", "第二轮同输入 + diff 开：九节全裁（跨轮 0 token 的接口口径）");
  eqNum(
    JSON.parse(env.js("JSON.stringify(promptSectionStats('assist'))")).total,
    9,
    "助手链按 runKey=assist 维护 9 节的快照",
  );
  const c3 = env.run({ state: { stateJson: STATE_B } }).systemPrompt;
  eqNum(c3, APP_STATE_HEAD + "当前应用状态 JSON：\n" + STATE_B, "只有应用状态变了 → 只重注 app_state 一节");
  ok(charLen(c3) < charLen(full) / 6, "省下的正是八节宿主长文（" + charLen(c3) + " / " + charLen(full) + " 字符）");
  eqNum(env.run({ state: { stateJson: STATE_A } }).systemPrompt, APP_STATE_HEAD + "当前应用状态 JSON：\n" + STATE_A, "状态改回去也照样只重注 app_state");
  const c5 = env.run({ s: { assistModel: "deepseek-v4-pro" } }).systemPrompt;
  eqNum(c5, full, "换 model（助手配置指纹变）→ 快照失效整段全量重发（内容与首轮逐字节相同）");
  eqNum(
    JSON.parse(env.js("JSON.stringify(promptSectionSnapshot('assist'))")).sig,
    env.js(
      /* 三个可见集通道都要显式给值：签名里少了任何一位，这条「登记的正是真实指纹」就白测 */
      "dshRunSigOf({ workspace: 'E:/dev/ws', model: 'deepseek-v4-pro', provider: 'deepseek-official', preset: 'standard', effort: 'high', pure: false, lean: false, noCanvas: false, hide: 'mtnode_db', maxTokens: 8192 })",
    ),
    "登记进快照的正是本轮真实算出的配置指纹（含 lean / noCanvas / 隐藏名单三位）",
  );
  env.js("setPromptSectionDiff(false)");
  eqNum(env.run().systemPrompt, full, "diff 关回出厂值：恢复逐字节全量下发");
}

/* =====================================================================
 * [D] 接线、加载顺序与降级（防静默断链）
 * ===================================================================== */
console.log("\n[D] 接线与降级（静态自检）");
const idxOfTag = (f) => indexHtml.indexOf('<script src="' + f + '">');
const orderTags = ["app-agent.js", "app-prompt-sections.js", "app-db.js", "app-assist.js"];
eqArr(orderTags.filter((f) => idxOfTag(f) < 0), [], "四个脚本都在 renderer/index.html 里");
ok(
  idxOfTag("app-prompt-sections.js") > idxOfTag("app-agent.js") &&
    idxOfTag("app-prompt-sections.js") < idxOfTag("app-db.js") &&
    idxOfTag("app-prompt-sections.js") < idxOfTag("app-assist.js"),
  "分节内核在 app-db.js / app-assist.js 之前加载（AGENTS.md：脚本顺序即模块分层）",
);
eqNum(countOf(kernelSrc, /function renderSections\(/g), 1, "renderSections 全仓只有一份定义（内核里）");
eqNum(countOf(dbSrc + assistSrc + agentSrc, /function (buildSections|renderSections)\(/g), 0, "消费方不自建第二套装配实现");
eqNum(countOf(kernelSrc, /const PROMPT_SECTION_ORDER = /g), 1, "规范节序表只有一个真源");
has(dbSrc, "renderSections(runKey, promptSections, { sig: runSig, full: resumeRound })", "节点链把 runKey + 配置指纹 + 续跑标记交给内核");
has(dbSrc, "if (pureOn || resumeRound) invalidatePromptSections(runKey);", "pure / 续跑轮点名作废快照");
has(dbSrc, "S._runSig[runKey] = runSig;", "配置指纹仍走 dshRunSigOf（与续跑登记同一份）");
ok(
  dbSrc.indexOf("const runKey = String(opts.runKey") < dbSrc.indexOf("const runSig = dshRunSigOf({"),
  "runKey 提前定型（取消句柄与分节快照共用同一个键）",
);
has(assistSrc, 'renderSections("assist", assistSections, {', "助手链按 runKey=assist 走内核");
has(assistSrc, 'join: "",', "助手链节间分隔符为空串（复现各段自带换行的串接口径）");
has(assistSrc, 'runKey: "assist",', "助手 dshRunTask 的 runKey 与分节快照主键一致");
/* 协议未动：多出的 sectionCache 字段必须被老网关无害忽略 */
eqNum(countOf(gwSrc, /sectionCache/g), 0, "gateway.mjs 完全不认识 sectionCache（按名解构 → 忽略即降级保底）");
has(gwSrc, "systemPrompt, preset, effort", "gateway.handleRun 仍按名取 systemPrompt（未改协议）");
has(mainDshSrc, "Object.assign({}, params, { dshHome })", "main-dsh 整包转发 runParams（新字段能过去）");
has(preloadSrc, "Object.assign({}, params, { reqId })", "preload.dshRun 整包透传（不白名单丢字段）");
eqNum(countOf(read("dsh/DESIGN.md"), /sectionCache/g), 0, "本轮无协议改动 → dsh/DESIGN.md 未新增字段");
/* 技能索引口径（推荐 Q5=B）：长期按内容哈希缓存，不裁剪条目、不内联全文 */
has(agentSrc, 'if (typeof promptSectionHash === "function") return String(promptSectionHash(s));', "技能索引哈希优先复用内核算法（可与节哈希直接比对）");
has(agentSrc, "if (_mtnodeSkillIndexCache.hash && _mtnodeSkillIndexCache.text) {", "索引命中即返回，不再走 IPC / 重复构造");
has(agentSrc, "if (_mtnodeSkillIndexPending) return _mtnodeSkillIndexPending;", "同轮并发合并成一次 IPC");
has(agentSrc, "function mtnodeInternalSkillIndexHash()", "索引哈希暴露给分节内核做同轮去重");
has(agentSrc, "r.compact || r.indexMd", "注入的仍是摘要块（不内联 SKILL.md 全文）");
ok(
  agentSrc.indexOf("Date.now() - _mtnodeSkillIndexCache") < 0 &&
    countOf(agentSrc, /_mtnodeSkillIndexCache = \{ hash: "", text: "", at: 0 \}/g) === 2,
  "取消 60s TTL：只按内容哈希长期缓存 + 显式失效",
);

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-systemprompt-sections)"
    : "\n✓ " + checks + " 项全部通过  (smoke-systemprompt-sections)",
);
process.exit(fails ? 1 : 0);
