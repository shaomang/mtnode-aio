"use strict";
/* 会话思考内容「不许被移除」+「显示思考内容」开关 —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-think-visible.js
 *
 * 需求（本次开发）：「会话中的思考内容被错误移除了，请修复，并在下方增加一个 toggle
 *                   是否显示思考内容」。
 *
 * 真源（都在项目根，本测试只做静态口径核对 + 抽真实现跑一遍）：
 *   renderer/app-db.js      traceSplitThink（续跑起步只**切开**思考段，一段都不删；
 *                           旧口径 traceDropThink 整段摘掉 = 思考内容被移除）
 *   renderer/app-assist.js  · 续跑重发（retry resumed=true）不再清思考槽
 *                           · agentRoundMsgTail：正常 / 终止 / 出错三条收尾路径共用
 *                             「思考 + 段快照 + 工具」归档，终止与出错不再丢思考
 *                           · agentModeEntryOf("think") = 模式菜单第三枚开关（默认显示）
 *                           · dshThinkShownFor / agentThinkShown 渲染判据 + 三处接线
 *                             （历史分段 / 运行中分段 / 无分段老消息 + 无分段 live 块）
 *   renderer/app-boot.js    会话水合 sess.showThink（缺省显示）
 *   renderer/i18n.js        新串中英成对
 *
 * 覆盖：
 *   [1] 续跑起步切开思考段（不删）—— 真实现
 *   [2] 续跑重发的清残文口径：resumed 时思考槽照旧保留（会话侧与节点侧对齐）
 *   [3] 三条收尾路径都归档思考（终止 / 出错不再丢）—— 真实现 agentRoundMsgTail
 *   [4] 「显示思考内容」开关：条目语义 / 落盘 / 水合 / 渲染判据 —— 真实现
 *   [5] 渲染接线：三处思考块 + live 回退块都受判据控制
 *   [6] i18n：新串逐条有英文词条
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
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + show(a) + "）");
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const hasnt = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);
const abs = (rel) => path.join(__dirname, "..", ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
function section(name) {
  console.log("\n" + name);
}

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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const BOOT = read("renderer/app-boot.js");
const HTML = read("renderer/index.html");
const I18N_SRC = read("renderer/i18n.js");
const I18n = require(abs("renderer/i18n.js"));

/* =====================================================================
 * [1] 续跑起步「切开」思考段（真实现：app-db.js 的轨迹模块）
 * ===================================================================== */
section("[1] 续跑起步切开思考段：思考内容一段都不删（真实现）");
ok(DB.indexOf("function traceSplitThink(") > 0, "app-db.js 有 traceSplitThink（切开，不删）");
hasnt(DB, "traceDropThink", "老口径 traceDropThink（整段摘掉思考）已从真源消失");
has(
  DB,
  "else if (opts.resumeSession) traceSplitThink(runKey);",
  "dshRunOnce 在续跑起步（resumeSession）时调用它（源码原文）",
);
{
  const S = {};
  const sandbox = { S, console };
  vm.createContext(sandbox);
  vm.runInContext(
    "const THINK_TINY_CHARS = 64;\n" +
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
        "traceSplitThink",
        "traceText",
      ]),
    sandbox,
    { filename: "think-visible-extract.js" },
  );
  const G = (n) => vm.runInContext("(typeof " + n + ' === "undefined" ? null : ' + n + ")", sandbox);
  /* 失败轮：思考 → 工具 → 正文半截 → 错误 */
  G("traceReset")("k1");
  G("tracePush")("k1", "think", "失败轮的旧思考", { turn: 1, step: 1 });
  G("tracePush")("k1", "tool", "", { turn: 1, step: 1, callId: "c1" });
  G("tracePush")("k1", "say", "失败轮的半截正文", { turn: 1, step: 1 });
  G("tracePush")("k1", "err", "429 Too Many Requests", { turn: 1, step: 1 });
  const tr = G("traceSplitThink")("k1");
  eqStr(
    G("traceText")("k1", "think"),
    "失败轮的旧思考",
    "切开之后旧思考仍在轨迹里（旧口径这里会变成空串 = 思考被移除）",
  );
  eqNum(tr.items.filter((it) => it.k === "think" && it.open === true).length, 0, "旧思考段已收口（不再吃后续增量）");
  eqNum(tr._thinkIdx, -1, "开放思考段下标复位");
  eqStr(G("traceText")("k1", "say"), "失败轮的半截正文", "正文段一字不动（续写要保）");
  /* 续跑轮的新思考：另起一段，不并进旧段 */
  G("tracePush")("k1", "think", "续跑轮的新思考", { turn: 2, step: 1 });
  eqStr(
    G("traceText")("k1", "think"),
    "失败轮的旧思考\n\n续跑轮的新思考",
    "两段思考都在、段间空行分隔（新思考不并进旧段）",
  );
  eqNum(tr.items.filter((it) => it.k === "think").length, 2, "思考段 = 2（旧段 + 新段），不拼成一坨");
  /* 归档口径：段快照里 think 段整段照收（限长闸明确不裁 think） */
  {
    const segMax = (DB.match(/const TRACE_SEG_MAX_CHARS = (\d+)/) || [])[1];
    ok(!!segMax, "抽到真实的 TRACE_SEG_MAX_CHARS（段快照预算）");
    vm.runInContext(
      "const TRACE_SEG_MAX_CHARS = " + segMax + ";\n" + extract(DB, ["traceSegmentsOf"]),
      sandbox,
      { filename: "segs.js" },
    );
    const segs = G("traceSegmentsOf")("k1");
    const thinks = segs.filter((s) => s.k === "think").map((s) => s.text);
    eqNum(thinks.length, 2, "段快照里两段思考都在（归档不丢）");
    eqStr(thinks.join("|"), "失败轮的旧思考|续跑轮的新思考", "段快照文本按序完整");
  }
}

/* =====================================================================
 * [2] 续跑重发（retry resumed=true）不清思考槽
 * ===================================================================== */
section("[2] 续跑重发的清残文口径：resumed 时思考槽保留（会话侧与节点侧对齐）");
{
  const at = ASSIST.indexOf('if (type === "retry") {', ASSIST.indexOf('runKey: "agent:" + st.id'));
  const blk = ASSIST.slice(at, at + 900);
  ok(at > 0, "抽到会话侧 onEvent 的 retry 分支");
  ok(
    /if \(data && data\.resumed\)\s*\{\s*\n\s*if \(mine\) updateAgentLiveThink\(st\);\s*\n\s*return;\s*\n\s*\}/.test(
      blk,
    ),
    "resumed=true 时直接返回（正文 / 工具 / 用量 / 思考一律保留）",
  );
  ok(
    blk.indexOf('delete S.thinking["agent:" + st.id]') >
      blk.indexOf("if (data && data.resumed)"),
    "清思考槽只在整轮重发（resumed=false）分支里 —— 续跑不再清掉用户已看到的思考",
  );
  hasnt(
    blk.slice(0, blk.indexOf("if (data && data.resumed)")),
    "delete S.thinking",
    "resumed 分支之前没有任何「先清思考」的代码（否则又会白删一次）",
  );
  /* 节点侧一直是保留的：两处口径对齐（本来就是它做对了） */
  const dbRetry = DB.slice(DB.indexOf('if (type === "retry") {'), DB.indexOf('if (type === "retry") {') + 700);
  ok(
    /if \(data && data\.resumed\) return;/.test(dbRetry),
    "节点侧（app-db.js onDshNodeEvent）resumed 时什么都不清（会话侧现在与它一致）",
  );
}

/* =====================================================================
 * [3] 三条收尾路径都把思考归档（真实现 agentRoundMsgTail）
 * ===================================================================== */
section("[3] 正常 / 终止 / 出错三条收尾路径共用一份「思考 + 段快照 + 工具」尾巴");
has(ASSIST, "function agentRoundMsgTail(", "app-assist.js 有 agentRoundMsgTail（收尾消息公共尾巴）");
{
  /* 真跑一次：轨迹里已有 think / say / err 段 → 尾巴必须挂上 reasoning 与 segments */
  const S = {
    thinking: { "agent:s1": ["残留内存缓冲（不该赢过轨迹）"] },
    runTrace: {},
  };
  const sb = {
    S,
    console,
    I18n: { t: (s) => String(s) },
    agentSegsForDisk: (list) => (Array.isArray(list) && list.length ? list : null),
  };
  vm.createContext(sb);
  const segMax3 = (DB.match(/const TRACE_SEG_MAX_CHARS = (\d+)/) || [])[1];
  vm.runInContext(
    "const THINK_TINY_CHARS = 64;\nconst TRACE_SEG_MAX_CHARS = " + segMax3 + ";\n" +
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
        "stripToolLines",
        "traceThinkDisplay",
        "traceSegmentsOf",
      ]) +
      "\n" +
      extract(ASSIST, ["agentRoundMsgTail"]),
    sb,
    { filename: "round-tail.js" },
  );
  const RUN = (code) => vm.runInContext(code, sb);
  RUN('traceReset("agent:s1")');
  RUN('tracePush("agent:s1", "think", "终止前的思考", { turn: 1, step: 1 })');
  RUN('tracePush("agent:s1", "say", "半截正文", { turn: 1, step: 1 })');
  const msg = RUN('agentRoundMsgTail({ _liveTools: [{ callId: "c1", name: "read" }] }, { role: "assistant", content: "半截正文" }, "agent:s1")');
  eqStr(msg.reasoning, "终止前的思考", "收尾消息挂上思考（终止 / 出错路径过去这里是空的 = 思考被丢掉）");
  ok(Array.isArray(msg.segments) && msg.segments.length >= 2, "收尾消息挂上段快照（时间线可还原）");
  ok(Array.isArray(msg.tools) && msg.tools.length === 1, "收尾消息挂上本轮工具清单");
  /* 无思考的一轮：不写空 reasoning（不制造空折叠块） */
  RUN('traceReset("agent:s2")');
  RUN('tracePush("agent:s2", "say", "只有正文", { turn: 1, step: 1 })');
  const msg2 = RUN('agentRoundMsgTail(null, { role: "assistant", content: "只有正文" }, "agent:s2")');
  eqNum(msg2.reasoning === undefined, true, "这一轮没有思考 → 不写 reasoning 字段");
}
{
  /* 三条收尾路径（正常 / _cancelled 终止 / catch 里取消类错误 / 其它出错）都走它 */
  const calls = (ASSIST.match(/agentRoundMsgTail\(\s*\n?\s*st,/g) || []).length;
  ok(calls >= 4, "agentRoundMsgTail 在收尾路径上被调用 " + calls + " 次（正常 + 终止 + 取消类错误 + 其它出错）");
  ok(
    /catch \(e\) \{[\s\S]{0,600}?st\._cancelled \|\| isCancelishError\(errMsg\)[\s\S]{0,400}?agentRoundMsgTail\(/.test(
      ASSIST,
    ),
    "被终止 / 取消类错误那条收尾也带思考尾巴（源码序：判取消 → 归档）",
  );
}

/* =====================================================================
 * [4] 「显示思考内容」开关：条目语义 / 落盘 / 水合 / 渲染判据（真实现）
 * ===================================================================== */
section("[4] 「显示思考内容」开关（模式菜单第三枚 toggle）");
ok(HTML.indexOf('id="agentModeMenu"') > 0, "index.html 有模式菜单宿主（开关落在既有菜单里，不改结构）");
{
  /* 真跑 agentModeEntryOf("think")：默认显示、toggle 翻转并落盘、重绘 */
  const calls = { persist: 0, composer: 0, render: 0 };
  let SESSION = { id: "as1", pure: false };
  const sb = {
    window: {},
    console,
    I18n: { t: (s) => String(s) },
    agentSessionState: () => SESSION,
    persistAgentSession: () => {
      calls.persist++;
    },
    renderAgentComposer: () => {
      calls.composer++;
    },
    renderAgentSession: () => {
      calls.render++;
    },
  };
  vm.createContext(sb);
  vm.runInContext(extract(ASSIST, ["agentModeEntryOf"]), sb, { filename: "mode-entry.js" });
  const entry = (st) => {
    SESSION = st;
    return vm.runInContext('agentModeEntryOf("think")', sb);
  };
  const def = entry({ id: "as1" });
  eqStr(def.key, "think", "开关 key = think");
  eqStr(def.label, "显示思考内容", "开关名 = 显示思考内容");
  eqNum(def.on, true, "默认显示（老会话 / 字段缺席都按显示，运行行为不变）");
  ok(/显示思考内容：开启中/.test(def.title), "开启态 tooltip 写明点击可隐藏");
  const next = entry({ id: "as1" });
  next.toggle();
  eqNum(SESSION.showThink, false, "点一下 → st.showThink = false（关掉显示）");
  ok(calls.persist >= 1, "开关写进会话落盘（persistAgentSession）");
  ok(calls.composer >= 1 && calls.render >= 1, "开关当场重绘（chip + 会话视图一起刷新）");
  const off = entry({ id: "as1", showThink: false });
  eqNum(off.on, false, "落盘后再读：off 态");
  ok(/显示思考内容：已关闭/.test(off.title), "关闭态 tooltip 写明可再显示");
  off.toggle();
  eqNum(SESSION.showThink, true, "再点一下 → 回到显示");
  /* 菜单行序：新开关在最后一行（「在下方增加一个 toggle」） */
  vm.runInContext("function agentAutoOnNow() { return true; }", sb);
  vm.runInContext(extract(ASSIST, ["agentModeEntries"]), sb, { filename: "mode-entries.js" });
  const keys = vm.runInContext("agentModeEntries().map(function (e) { return e.key; })", sb);
  eqStr(keys.join(","), "pure,auto,think", "菜单行序 = 纯净模式 / 自动续跑 / 显示思考内容（第三枚 = 最下方）");
}
{
  /* 落盘白名单 + 重启水合：缺省 / 老存档 = 显示 */
  has(ASSIST, "showThink: s.showThink !== false,", "persistAgentSession 白名单带上 showThink（缺省 true）");
  has(BOOT, "sess.showThink = sess.showThink !== false;", "app-boot 水合会话时归一 showThink（缺省显示）");
  /* chip 的 tooltip 逐项回显不再写死 pure + auto（否则新开关进不了提示） */
  ok(
    /t\.title = I18n\.t\("模式："\) \+ entries\.map\(mark\)\.join\(" \/ "\);/.test(ASSIST),
    "「模式」chip tooltip 逐项遍历（新开关自动进提示）",
  );
  has(ASSIST, 'I18n.t("以上开关都只作用于当前会话，随时可改")', "菜单说明文案改成「以上开关…」（三项都在）");
}
{
  /* 渲染判据真跑：按「这条消息属于哪条会话」取，别的视图（团队 / 节点 / 助手）不受影响。
     判据直接读会话表本体（S.agentSessions）—— 整表重绘里每条消息都问一次，
     这里故意把 agentSessions()（会逐会话做水合）打桩成抛错：一旦回退用它就立刻炸。 */
  const sb = {
    console,
    S: { agentSessions: [{ id: "as1", showThink: false }, { id: "as2" }] },
    agentSessions: () => {
      throw new Error("判据不该走 agentSessions()（逐会话水合，太贵）");
    },
  };
  vm.createContext(sb);
  vm.runInContext(
    extract(ASSIST, ["dshThinkShownFor", "agentThinkShown"]),
    sb,
    { filename: "think-shown.js" },
  );
  const Q = (code) => vm.runInContext(code, sb);
  eqNum(Q('dshThinkShownFor("as1")'), false, "关掉显示的会话 → 思考块不渲染");
  eqNum(Q('dshThinkShownFor("as2")'), true, "字段缺席的会话 → 照常显示");
  eqNum(Q('dshThinkShownFor("chat-1")'), true, "不是会话 id 的视图（团队 / 节点会话 / 助手）→ 照常显示");
  eqNum(Q('dshThinkShownFor("")'), true, "没有归属 → 照常显示");
  eqNum(Q("agentThinkShown({ showThink: false })"), false, "会话对象口径同源（live 渲染用）");
  eqNum(Q("agentThinkShown(null)"), true, "拿不到会话时按显示（老路径不退化）");
}

/* =====================================================================
 * [5] 渲染接线：三处思考块 + live 回退块都受判据控制
 * ===================================================================== */
section("[5] 渲染接线（历史分段 / 运行中分段 / 无分段老消息 / 无分段 live 块）");
has(ASSIST, "function dshHistSegEl(seg, pool, nodeId, idx, n, showThink) {", "历史分段渲染接收 showThink 判据");
has(
  ASSIST,
  'if (showThink === false) return null;',
  "历史思考段：关掉时整块不渲染（其余段照旧）",
);
has(
  ASSIST,
  "const el = dshHistSegEl(m.segments[n], pool, nodeId, idx, n, showThink);",
  "dshMsgBlock 把判据传进历史分段渲染",
);
has(ASSIST, "const showThink = dshThinkShownFor(nodeId);", "dshMsgBlock 按消息归属解析判据");
ok(
  /m\.role === "assistant" &&\s*\n\s*!segsView &&\s*\n\s*showThink &&/.test(ASSIST),
  "无分段的老消息（整段 m.reasoning）同样受判据控制",
);
has(ASSIST, "const showThink = agentThinkShown(st);", "运行中分段渲染（agentLiveSegsEl）按本会话取判据");
ok(
  /if \(seg\.k === "think"\) \{\s*\n\s*\/\* 「显示思考内容」关掉[\s\S]{0,200}?if \(!showThink\) continue;/.test(
    ASSIST,
  ),
  "运行中思考段：关掉时跳过（不建 DOM、也不参与就地更新）",
);
has(
  ASSIST,
  "if (agentThinkShown(st)) row.appendChild(think);",
  "无分段 live 的思考块（节点绑定运行等）关掉时不挂进 DOM",
);
/* 关掉只是不渲染：数据侧一字不动 */
ok(
  ASSIST.indexOf("agentRoundMsgTail") > 0 &&
    /if \(String\(rsn\)\.trim\(\)\) msg\.reasoning = rsn;/.test(ASSIST),
  "开关不影响归档（思考照旧写进 msg.reasoning / segments）",
);

/* =====================================================================
 * [6] i18n：新串逐条有英文词条（真模块跑一遍）
 * ===================================================================== */
section("[6] i18n：新串中英成对");
const keys = [
  "显示思考内容",
  "关掉后会话里不再显示模型的思考块（思考内容仍随消息存档，随时可再打开）",
  "显示思考内容：开启中，点击隐藏会话里的模型思考块",
  "显示思考内容：已关闭，点击重新显示会话里的模型思考块",
  "以上开关都只作用于当前会话，随时可改",
];
for (const k of keys) {
  ok(I18N_SRC.indexOf('"' + k + '"') >= 0, "i18n 表里有词条：" + k.slice(0, 16));
}
I18n.setLocale("en");
for (const k of keys) {
  const en = I18n.t(k);
  ok(en && en !== k && !/[\u4e00-\u9fa5]/.test(en), "英文界面已译（无中文残留）：" + k.slice(0, 16));
}
ok(/Show thinking/.test(I18n.t("显示思考内容")), "英文词条语义对得上（Show thinking）");
I18n.setLocale("zh");
eqStr(I18n.t("显示思考内容"), "显示思考内容", "中文口径原样返回（中文为键）");

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-visible)",
);
process.exit(fails ? 1 : 0);
