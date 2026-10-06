/* 冒烟：会话流标记（本次需求 · 把 DeepSeek 桌面端 0.2.0-rc.2 的会话可视化融入 MTNode）
 *
 * 上游依据（本机 dsh/gateway/node_modules/@deepseek-ai/ 下、版本 0.2.0-rc.2）：
 *   · dsh-client-ui-tool      工具卡片 ToolRow（标题 / 准备态 / 失败摘要 / 运行中扫光 / diff）
 *   · dsh-client-ui-primitives  DiffBlock（+/- 行、3px 内嵌左色条、9 行折叠）
 *   · dsh-client-ui-chat      turn-process 折叠行、context 注入行、turn-tail 页脚动作行、
 *                             四档展示策略（ChatPresentationPolicy）
 *   · dsh-client-ui-conversation 中文词条（tool.title.* / tool.*.running / message.turnProcess.*）
 * 与上游的一致性口径：**形态照上游，颜色走本仓 --dsh-* 语义令牌**（亮暗同源，不写死 hex）。
 *
 * 这一批做的是「会话流内的标记」：
 *   [1] 网关：工具参数增量 → tool-preparing（准备态取数）
 *   [2] 轨迹模型：tool-prep / ctx 两种新段的落段与收口
 *   [3] 工具卡片：标题 / 状态 / 准备态 / 失败摘要 / diff 统计（真函数跑）
 *   [4] diff：从调用参数现算 + 9 行折叠（真函数跑）
 *   [5] 上下文注入行：只在工具增删时出现（真函数跑）
 *   [6] 轮次：过程折叠行 + 页脚动作行 + 四档展示策略（真函数跑）
 *   [7] 接线与样式：CSS / 设置 / i18n / 冒烟口径
 *
 * 跑法：node test/smoke-session-markers.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok    " + label);
  else {
    fails++;
    console.log("  FAIL  " + label);
  }
}
function section(t) {
  console.log("\n" + t);
}
function has(src, needle, label) {
  ok(src.indexOf(needle) >= 0, label);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* 抽真函数体（与其它冒烟同一套朴素括号配对；字符串与注释里的括号不算） */
function fnBody(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("函数没找到：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n\n");

const GW = read("dsh/gateway/gateway.mjs");
const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const APP_AGENT = read("renderer/app-agent.js");
const BOOT = read("renderer/app-boot.js");
const SETTINGS = read("renderer/app-settings.js");
const DSH_CSS = read("renderer/css/dsh.css");
const LIGHT_CSS = read("renderer/css/theme-light.css");
const TOKENS = read("renderer/css/dsh-tokens.css");
const I18N_SRC = read("renderer/i18n.js");
const I18n = require(path.join(ROOT, "renderer", "i18n.js"));

/* =====================================================================
 * [1] 网关：工具参数增量 → tool-preparing
 * ===================================================================== */
section("[1] 网关准备态取数（gateway.mjs）");
has(GW, "const toolPrepAcc = new Map()", "[1] 准备态累计器按 callId 记账");
has(
  GW,
  "else if (c.type === 'tool-call-delta') {",
  "[1] 认上游的 tool-call-delta（dsh-llm 的 StreamChunk：index/id/name/argumentsDelta）",
);
has(GW, "cur.bytes += String(c.argumentsDelta == null ? '' : c.argumentsDelta).length", "[1] 只累计参数字符数（不攒正文）");
has(GW, "emit('tool-preparing', {", "[1] 下发 tool-preparing（callId/name/bytes + turn/step）");
has(GW, "TOOL_PREP_MIN_GAP_MS", "[1] 限频：不逐块刷事件");
has(GW, "toolPrepAcc.delete(String(d.callId == null ? '' : d.callId))", "[1] 真 tool/call 到达即清账（卡片转「运行中」）");
has(GW, "case 'turn/end':", "[1] turn/end 分支仍在（换轮清准备态）");
ok(
  /case 'turn\/end':\s*\n\s*\/\* 换轮[\s\S]{0,200}?toolPrepAcc\.clear\(\)/.test(GW),
  "[1] 换轮把准备态记账整清（不跨轮残留）",
);
has(GW, "TOOL_PREP_MAX_CALLS", "[1] 记账户数有上限（异常流不会涨内存）");
ok(
  !/emit\('tool-preparing'[\s\S]{0,200}?argumentsDelta:/.test(GW),
  "[1] 事件里不带参数正文（准备态只有名字与字节数）",
);

/* =====================================================================
 * [2] 轨迹模型：tool-prep / ctx 两种新段
 * ===================================================================== */
section("[2] 轨迹模型（app-db.js）");
has(DB, '} else if (type === "tool-preparing") {', "[2] traceFeedEvent 认 tool-preparing");
has(DB, 'tracePush(runKey, "tool-prep", "", e);', "[2] 转成 tool-prep 段");
has(DB, 'if (kind === "tool-prep") {', "[2] tracePush 有 tool-prep 分支");
ok(
  /kind === "tool-prep"[\s\S]{0,900}?it\.prep = \{ bytes, name/.test(DB),
  "[2] 同一个 callId 只刷新那一项（不新起段）",
);
ok(
  DB.indexOf('if (kind === "tool-prep")') < DB.lastIndexOf('if (kind === "tool") {'),
  "[2] tool-prep 分支在 tool 分支之前（真 tool/call 仍会成段）",
);
ok(
  !/kind === "tool-prep"[\s\S]{0,600}?tr\._calls\[callId\] = 1/.test(DB),
  "[2] 准备态不写 tr._calls 去重账（否则真调用会被吞掉）",
);
has(DB, 'else if (t === "developer/message") {', "[2] 上下文注入行认 developer/message");
has(DB, "function traceContextNoteOf(data)", "[2] 抽工具增删的辅助函数在位");
has(DB, 'b.type === "tool-addition"', "[2] 认上游 ToolAdditionBlock 的 type");
has(DB, 'b.type === "tool-removal"', "[2] 认上游 ToolRemovalBlock 的 type");
has(DB, 'if (kind === "ctx") {', "[2] tracePush 有 ctx 分支");
ok(
  /const cit = \{\s*\n\s*k: "ctx",[\s\S]{0,400}?items\.push\(cit\);/.test(DB),
  "[2] ctx 段照原样进时间线（不参与正文拼接）",
);

/* =====================================================================
 * [3] 工具卡片（真函数）
 * ===================================================================== */
section("[3] 工具卡片：标题 / 状态 / 准备态 / 失败摘要（真函数跑）");
{
  const sb = {
    console,
    I18n: {
      t: (s, p) =>
        String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)),
    },
  };
  vm.createContext(sb);
  vm.runInContext(
    extract(ASSIST, ["dshToolTitleOf", "dshToolIsCustom", "dshToolStateOf", "dshToolPrepText", "dshToolErrSummary"]) +
      "\n" +
      /const DSH_TOOL_TITLE_RULES = \[[\s\S]*?\n\];/.exec(ASSIST)[0] +
      "\n" +
      /const DSH_CUSTOM_TOOL_RES = \[[\s\S]*?\n\];/.exec(ASSIST)[0] +
      "\n" +
      extract(ASSIST, ["dshOneLine"]),
    sb,
    { filename: "tool-card.js" },
  );
  const Q = (code) => vm.runInContext(code, sb);
  /* 标题：上游 tool.title.* 的中文口径 */
  const cases = [
    ["read", "读取"],
    ["read_image", "读取图片"],
    ["write", "写入"],
    ["edit", "编辑"],
    ["str_replace_editor", "编辑"],
    ["pwsh", "运行命令"],
    ["bash", "运行命令"],
    ["grep", "搜索文件内容"],
    ["glob", "查找文件"],
    ["web_search", "网页搜索"],
    ["web_fetch", "网页获取"],
    ["todo_write", "更新计划"],
    ["subagent", "子智能体"],
  ];
  let bad = [];
  for (const [name, label] of cases) {
    const got = Q("dshToolTitleOf({name:" + JSON.stringify(name) + "})");
    if (got !== label) bad.push(name + "→" + got);
  }
  ok(bad.length === 0, "[3] 工具族标题照上游 tool.title.*（" + cases.length + " 例）" + (bad.length ? " 例外：" + bad.join(" ") : ""));
  /* 非 dsh 工具（本次需求）：MTNode 自有 + 被 MTNode 接管的引擎工具 —— 一并走中文标签，
     原来这些名字只能回落成「工具调用」再显英文原名。 */
  const customCases = [
    ["read_image", "读取图片"],
    ["mtnode_canvas_get", "读取画布"],
    ["mtnode_canvas_edit", "编辑画布"],
    ["mtnode_app", "画布应用"],
    ["mtnode_vision", "读取图片"],
    ["mtnode_db", "数据库查询"],
    ["mtnode_facts", "AI 事实库"],
    ["mtnode_assets", "素材库"],
    ["lt_state", "长任务状态"],
    ["browser_snapshot", "浏览器快照"],
    ["browser_screenshot", "浏览器截图"],
    ["ask_user_question", "询问用户"],
    ["create_goal", "建目标"],
    ["update_goal", "改目标"],
    ["todo_write", "更新计划"],
    ["subagent_fork", "派生子智能体"],
    ["list_agents", "列出子智能体"],
    ["send_message", "发消息"],
    ["job_output", "读取后台任务"],
  ];
  let cbad = [];
  for (const [name, label] of customCases) {
    const got = Q("dshToolTitleOf({name:" + JSON.stringify(name) + "})");
    if (got !== label) cbad.push(name + "→" + got);
  }
  ok(cbad.length === 0, "[3] 非 dsh 工具照本仓词表给中文标签（" + customCases.length + " 例）" + (cbad.length ? " 例外：" + cbad.join(" ") : ""));
  /* 分类：非 dsh → 药丸挂 .t-custom（工具库紫）；dsh 自带与表外一律不挂（保持青色） */
  {
    const want = [
      ["ask_user_question", true],
      ["mtnode_canvas_edit", true],
      ["mtnode_facts", true],
      ["lt_state", true],
      ["browser_click", true],
      ["job_kill", true],
      ["read", false],
      ["pwsh", false],
      ["grep", false],
      ["web_search", false],
      ["subagent", false],
      ["some_unknown_tool", false],
    ];
    let xbad = [];
    for (const [name, exp] of want) {
      const got = Q("dshToolIsCustom({name:" + JSON.stringify(name) + "})");
      if (got !== exp) xbad.push(name + "→" + got);
    }
    ok(xbad.length === 0, "[3] 非 dsh 工具专属色类判据（" + want.length + " 例）" + (xbad.length ? " 例外：" + xbad.join(" ") : ""));
    ok(
      Q('dshToolTitleOf({name:"some_unknown_tool"})') === "工具调用",
      "[3] 两表都不命中的工具仍回落「工具调用」（卡片显示原始工具名，见 dshToolDetailsEl 的 shown 判定）",
    );
  }
  /* 状态机：preparing / running / ok / error / stopped（上游 ToolRowState） */
  ok(Q('dshToolStateOf({callId:"c1",prep:{bytes:10}},true)') === "preparing", "[3] 有 prep 且还没派发 → preparing");
  ok(Q('dshToolStateOf({callId:"c1",name:"read",args:"{}"},true)') === "running", "[3] 已派发未回结果 → running");
  ok(Q('dshToolStateOf({callId:"c1",name:"read",args:"{}",result:[]},true)') === "ok", "[3] 有结果 → ok");
  ok(Q('dshToolStateOf({callId:"c1",error:{name:"E"}},true)') === "error", "[3] 带 error → error（优先于其它态）");
  ok(Q('dshToolStateOf({callId:"c1",stopped:true,result:[]},false)') === "stopped", "[3] stopped 标志 → stopped");
  /* 准备态文案：上游口径 Math.ceil(raw.length / 1024) */
  ok(Q("dshToolPrepText(1)") === "正在准备内容 1 KB", "[3] 1 字节也算 1 KB（上游向上取整）");
  ok(Q("dshToolPrepText(2048)") === "正在准备内容 2 KB", "[3] 2 KB 照直算");
  ok(Q("dshToolPrepText(2049)") === "正在准备内容 3 KB", "[3] 超出即进一档（不是文件真实体积）");
  /* 失败摘要：名字 + 码 + 一句正文，超长截断 */
  ok(
    Q('dshToolErrSummary({error:{name:"ToolError",code:"EACCES",message:"denied"}})') ===
      "ToolError EACCES · denied",
    "[3] 失败摘要 = 错误名 + 码 + 一句正文",
  );
  ok(Q("dshToolErrSummary({})") === "", "[3] 没出错就没有摘要（不挂空节点）");
  ok(
    Q('dshToolErrSummary({error:{message:"x".repeat(200)}}).length') <= 90,
    "[3] 摘要正文截断（不把整篇错误刷到一行里）",
  );
}

/* =====================================================================
 * [4] diff：从调用参数现算 + 9 行折叠（真函数）
 * ===================================================================== */
section("[4] 文件改动 diff（真函数跑）");
{
  const sb = {
    console,
    I18n: { t: (s) => String(s) },
    document: {
      createElement: () => ({
        className: "",
        textContent: "",
        children: [],
        dataset: {},
        hidden: false,
        disabled: false,
        appendChild(c) {
          this.children.push(c);
        },
        addEventListener() {},
      }),
    },
  };
  vm.createContext(sb);
  vm.runInContext(
    extract(ASSIST, [
      "dshDiffArgText",
      "dshDiffRowsOf",
      "dshDiffPartsOf",
      "dshToolArgsObj",
      "dshToolDiffOf",
      "dshToolDiffOfFull",
      "dshOneLine",
      "dshIsShellTool",
      "dshIsGrepTool",
      "dshIsGlobTool",
      "dshIsSearchTool",
    ]) +
      "\nvar DSH_DIFF_MAX_ROWS = 9;\nvar DSH_DIFF_MAX_CHARS = 300000;\n" +
      "\nvar DSH_DIFF_WRITE_RE = /^(write|write_file|create_file)$/;\n" +
      "\nvar DSH_DIFF_EDIT_RE = /^(edit|edit_file|str_replace_editor|apply_patch)$/;\n",
    sb,
    { filename: "diff.js" },
  );
  const Q = (code) => vm.runInContext(code, sb);
  const d = Q(
    'JSON.stringify(dshToolDiffOf({name:"edit",args:{file_path:"E:/p/a.js",old_string:"a\\nb\\nc",new_string:"a\\nB\\nc"}}))',
  );
  const parsed = JSON.parse(d);
  ok(parsed.path === "E:/p/a.js", "[4] diff 带文件路径（上游 DiffBlock 的 path）");
  ok(parsed.added === 1 && parsed.removed === 1, "[4] edit 的 old → new 算出一增一删");
  ok(
    parsed.rows.filter((r) => r.k === "add").length === 1 &&
      parsed.rows.filter((r) => r.k === "del").length === 1,
    "[4] 行级写成 add / del（上游 ::before 的 + / - 前缀同源）",
  );
  ok(
    parsed.rows[0].k === "ctx" && parsed.rows[parsed.rows.length - 1].k === "ctx",
    "[4] 改动前后各留上下文行（上游折叠时保留前后各 3 行）",
  );
  const w = JSON.parse(
    Q('JSON.stringify(dshToolDiffOf({name:"write",args:{file_path:"E:/p/b.txt",content:"x\\ny\\nz"}}))'),
  );
  ok(w.added === 3 && w.removed === 0, "[4] write（新建 / 覆盖）整篇算新增");
  ok(
    Q('dshToolDiffOf({name:"read",args:{file_path:"a.js"}})') === null,
    "[4] read / grep / shell 这类不算 diff（不挂空的差异块）",
  );
  ok(
    Q('dshToolDiffOf({name:"edit",args:{file_path:"a.js"}})') === null,
    "[4] 拿不到改前改后（没有 old/new）→ 不编一份假 diff",
  );
  const big = JSON.parse(
    Q(
      'JSON.stringify(dshDiffRowsOf(' +
        JSON.stringify(Array.from({ length: 40 }, (_, i) => "l" + i).join("\n")) +
        "," +
        JSON.stringify(Array.from({ length: 40 }, (_, i) => "L" + i).join("\n")) +
        ',"E:/p/big.js"))',
    ),
  );
  ok(big.rows.length === 80, "[4] 大改动行数不设上限（折叠交给渲染层，数据一份不少）");
  ok(big.hidden === 0, "[4] 没有公共上下文时 hidden = 0");
}
has(ASSIST, "const DSH_DIFF_MAX_ROWS = 9;", "[4] 会话内折叠上限 = 9 行（上游 CHAT_DIFF_MAX_LINES）");
ok(
  ASSIST.indexOf("const rows = limit ? diff.rows.slice(0, limit) : diff.rows;") > 0 &&
    /* 折叠态画到 min(foldCap, rowsLimit)；对话 / 轨迹不传 opts ⟹ 阈值缺省回落上限常量 */
    /foldCap =\s*\r?\n\s*o && Number\(o\.foldCap\) > 0/.test(ASSIST) &&
    /:\s*DSH_DIFF_MAX_ROWS;/.test(ASSIST) &&
    /function dshToolDiffEl\(diff\) \{\s*\r?\n\s*return dshDiffBlockEl\(diff, null\);/.test(ASSIST),
  "[4] 渲染层按上限切片（折叠后点一下就地展开；对话 / 轨迹缺省仍 = 9 行）",
);
/* 两条断言原先写的是**带 \n 的字面串**，而这两份源文件是 CRLF 行尾 —— indexOf 恒不命中，
   它们从写下那天起就恒红（不是代码坏了）。改成行尾无关的正则：真回归才算数。 */
ok(
  /more\.textContent = foldedNow\(\)\s*\r?\n\s*\? I18n\.t\("… 其余 \{n\} 行"/.test(ASSIST),
  "[4] 折叠提示照上游「… 其余 N 行」",
);
ok(
  /if \(diff\) \{\s*\n\s*const dEl = dshToolDiffEl\(diff\);/.test(ASSIST),
  "[4] diff 块挂在工具卡片展开体的最前",
);

/* =====================================================================
 * [5] 上下文注入行（真函数）
 * ===================================================================== */
section("[5] 上下文注入行（真函数跑）");
{
  const sb = {
    console,
    I18n: {
      t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)),
    },
  };
  vm.createContext(sb);
  vm.runInContext(extract(ASSIST, ["dshContextText"]), sb, { filename: "ctx.js" });
  const Q = (code) => vm.runInContext(code, sb);
  ok(
    Q('dshContextText({names:{added:["read"],removed:[]}})') === "已添加工具：read",
    "[5] 单个新增 → 点名（上游 message.toolAdded）",
  );
  ok(
    Q('dshContextText({names:{added:[],removed:["read"]}})') === "已移除工具：read",
    "[5] 单个移除 → 点名（上游 message.toolRemoved）",
  );
  ok(
    Q('dshContextText({names:{added:["a","b"],removed:[]}})') === "新增 2 个工具",
    "[5] 多了只报个数（上游 message.toolsAdded）",
  );
  ok(
    Q('dshContextText({names:{added:["a","b","c"],removed:["d"]}})') === "已添加工具：a、b、c；已移除工具：d",
    "[5] 条目还少（≤4）时逐个点名，增删并列在一句里",
  );
  ok(
    Q('dshContextText({names:{added:["a","b","c"],removed:["d","e"]}})') === "新增 3 个，移除 2 个",
    "[5] 条目多了只报个数（上游 message.toolsChanged 口径）",
  );
  ok(
    Q('dshContextText({names:{added:[],removed:[]},text:"   "})') === "",
    "[5] 没有工具增删 → 空串（上游默认不显示普通上下文注入）",
  );
}
has(ASSIST, "function dshContextRowEl(seg)", "[5] 上下文注入行渲染器在位");
ok(
  /dshContextRowEl\(seg\)[\s\S]{0,600}?textContent = I18n\.t\("上下文注入"\)/.test(ASSIST),
  "[5] 行首是「上下文注入」标签（上游 message.contextInjection）",
);
has(ASSIST, 'if (seg.k === "ctx") {', "[5] 历史分段渲染接上 ctx（并给它挂上这一项自己的时刻栏）");
ok(
  /if \(seg\.k === "ctx"\) \{[\s\S]{0,200}?dshSegTimeAttach\(c, seg\.at, 0, msgAt\);/.test(ASSIST),
  "[5] ctx 行也挂自己的时刻栏（历史路径）",
);
ok(
  /seg\.k === "ctx"[\s\S]{0,200}?dshContextRowEl\(seg\)/.test(ASSIST),
  "[5] 运行中分段渲染也接上 ctx",
);

/* =====================================================================
 * [6] 轮次：**不做任何收纳** + 逐项时刻 + 四档策略（真函数跑）
 * ===================================================================== */
section("[6] 轮次组织（不收纳工具调用 + 逐项时刻 + 四档策略）");
{
  const sb = {
    console,
    S: { config: { dsh: { transcriptView: "standard" } } },
    I18n: { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) },
    fmtDur: (ms) => Math.round(ms / 1000) + "s",
  };
  vm.createContext(sb);
  vm.runInContext(
    extract(ASSIST, ["dshTranscriptViewNorm", "dshTranscriptViewGlobal", "dshPolicyOfView"]) +
      "\nvar DSH_TRANSCRIPT_VIEWS = ['compact','standard','detailed','verbose'];\nvar DSH_TRANSCRIPT_DEFAULT = 'standard';\n",
    sb,
    { filename: "policy.js" },
  );
  const Q = (code) => vm.runInContext(code, sb);
  ok(Q('dshTranscriptViewGlobal()') === "standard", "[6] 全局默认 = standard（上游默认档）");
  ok(Q('dshPolicyOfView("compact").showThink') === false, "[6] 简洁档：不显示思考块");
  ok(Q('dshPolicyOfView("standard").showThink') === true, "[6] 标准档：显示思考块");
  /* 本次需求：会话里的思考一律收成一行摘要条、点开在弹窗里读 —— 档位不再管
     「思考落地即展开」这一位（expandThink 整只撤掉，删掉它是因为它已经没有地方生效）。 */
  ok(
    Q('typeof dshPolicyOfView("detailed").expandThink') === "undefined",
    "[6] 详细档不再有 expandThink（思考一律点开弹窗，没有「落地即展开」）",
  );
  ok(
    Q('typeof dshPolicyOfView("verbose").expandThink') === "undefined",
    "[6] 完全展开档同样没有 expandThink",
  );
  ok(
    Q('dshPolicyOfView("detailed").showThink') === true &&
      Q('dshPolicyOfView("verbose").showThink') === true,
    "[6] 详细 / 完全展开档仍显示思考（只是形态换成可点的一行摘要条）",
  );
  ok(Q('dshPolicyOfView("verbose").expandProcess') === true, "[6] 完全展开：工具卡也默认摊开");
  ok(
    Q('typeof dshPolicyOfView("standard").foldCompletedTurns') === "undefined",
    "[6] 策略里**没有** foldCompletedTurns 这一位（过程行折叠已按本轮需求整只撤掉）",
  );
  ok(Q('dshPolicyOfView("nope").view') === "standard", "[6] 非法档位回落标准档");
}
/* 收纳口径（本轮需求 · 用户口径「工具调用不应当被收纳，否则会和工具在顺序上分离」）：
   折叠行渲染器与它的调用点都必须不存在，段一律按段序内联 append。 */
ok(
  ASSIST.indexOf("function dshTurnProcessFold(") < 0 && ASSIST.indexOf("__REMOVED_dshTurnProcessFold") < 0,
  "[6] 轮次过程折叠行渲染器已删除（不留死函数）",
);
ok(
  ASSIST.indexOf("const foldRow = dshTurnProcessFold(") < 0 && ASSIST.indexOf("foldRow") < 0,
  "[6] dshMsgBlock 不再建折叠行（工具段不会被搬进任何收纳体）",
);
ok(
  /for \(let n = from; n < m\.segments\.length; n\+\+\) \{[\s\S]{0,400}?body\.appendChild\(el\);/.test(ASSIST),
  "[6] 历史段一律按段序内联 append 进正文（没有任何「搬进折叠体」的分支）",
);
has(ASSIST, "不应当进行任何收纳", "[6] 原址留了「为什么撤掉」的说明（后人不会再把它加回来）");
ok(
  !/dsh-turn-process/.test(DSH_CSS.replace(/\/\*[\s\S]*?\*\//g, " ")) &&
    !/dsh-turn-process/.test(ASSIST.replace(/\/\*[\s\S]*?\*\//g, " ")),
  "[6] 折叠行样式与类名一并撤掉（.dsh-turn-process* 在 CSS / JS 代码里都不再出现；注释里可留历史说明）",
);
/* 逐项时刻（本轮需求 · 用户口径「时间应当在每一项，而不是总项」）：
   每一项左侧一条恒显时刻（工具项带耗时），来源只有两处真实记录（段自己的 at / 工具 at·doneAt）。 */
has(ASSIST, "function dshSegTimeEl(own, doneAt, msgAt)", "[6] 逐项时刻栏渲染器在位");
has(ASSIST, "function dshSegDurText(at, doneAt)", "[6] 工具项的耗时格式化在位");
has(ASSIST, "function dshSegTimeAttach(host, own, doneAt, msgAt)", "[6] 时刻栏挂载口径在位");
has(ASSIST, "function dshSegSetStreamText(el, txt)", "[6] 流式正文就地更新时不冲掉时刻栏");
ok(
  /* 历史 + 运行中两条渲染路径的每一项都挂：思考 / 正文 / 工具 / 上下文注入
     （本次需求后历史思考段的时刻栏宿主是 .dsh-seg-think-wrap 那一层 row，
       运行中依然是 box —— 两处都必须挂着，思考不能因为换成一行摘要条就丢了时刻）。 */
  /dshSegTimeAttach\(row, seg\.at, 0, msgAt\)/.test(ASSIST) &&
    /dshSegTimeAttach\(box, seg\.at, 0, 0\)/.test(ASSIST) &&
    /dshSegTimeAttach\(d, seg\.at, 0, msgAt\)/.test(ASSIST) &&
    /dshSegTimeAttach\(wrap, t && t\.at, t && t\.doneAt, msgAt\)/.test(ASSIST) &&
    /dshSegTimeAttach\(c, seg\.at, 0, msgAt\)/.test(ASSIST) &&
    /dshSegTimeAttach\(d, seg\.at, 0, 0\)/.test(ASSIST) &&
    /dshSegTimeAttach\(wrap, t\.at \|\| seg\.at, t\.doneAt, 0\)/.test(ASSIST) &&
    /dshSegTimeAttach\(c, seg\.at, 0, 0\)/.test(ASSIST),
  "[6] 历史与运行中两条路径的每一项（思考 / 正文 / 工具 / 注入）都挂自己的时刻栏",
);
ok(
  !/dshChatMetaEl|dshChatTickText/.test(ASSIST) && DSH_CSS.indexOf(".dsh-chat-meta") < 0,
  "[6] 旧的段尾「时刻 · 耗时」刻度（.dsh-chat-meta）整只撤掉（同一份时间不再两处显示）",
);
/* ── 本次需求：思考不再是 <details> 下拉，改成一行摘要条 + 点击开弹窗 ──────────
   口径（拷问共识）：会话里只留一行「◉ 思考 · N 字」，整行可点；全文与译文在
   居中 #overlay 弹窗里左右分栏看；旧的下拉展开逻辑、只服务于它的样式、以及
   「详细 / 完全展开 = 思考落地即展开」那一位（expandThink）一并删掉 ——
   同一处只留一条交互口径。 */
ok(
  /function dshThinkRowEl\(desc\)/.test(ASSIST) &&
    /function openDshThinkPop\(desc\)/.test(ASSIST) &&
    (ASSIST.match(/dshThinkRowEl\(\{/g) || []).length >= 4,
  "[6] 思考摘要条与弹窗渲染器在位（历史消息 / 运行中 / 无分段旧渲染 / 节点会话四处共用同一行）",
);
ok(
  !/det\.className = "dsh-seg dsh-seg-think"/.test(ASSIST) &&
    !/det\.className = "dsh-think"/.test(ASSIST) &&
    /* 助手栏（右侧那一栏）运行中的思考仍是一段纯文本（#assist-think），本来就没有下拉；
       这里只钉会话两条渲染路径不再建 details */
    (ASSIST.match(/dsh-think-live/g) || []).length === 1 &&
    !/\.dsh-seg-think>summary/.test(ASSIST),
  "[6] 思考不再建 <details>（点击开弹窗，没有「展开 / 收起」这一层）",
);
ok(
  !/dshThinkTranslateAppend|dsh-think-bar|document\.getElementById\("agent-think-body"\)/.test(ASSIST) &&
    !/S\.openDshTools\[oKey\]/.test(ASSIST) &&
    !/S\._agentThinkOpen/.test(ASSIST),
  "[6] 旧下拉的按钮挂载（dshThinkTranslateAppend / dsh-think-bar）与展开态键一并撤掉",
);
ok(
  !/\.dsh-seg-think>summary/.test(DSH_CSS) &&
    !/\.dsh-seg-think summary/.test(DSH_CSS) &&
    !/\.dsh-seg-think pre/.test(DSH_CSS) &&
    /button\.dsh-think-row/.test(DSH_CSS),
  "[6] 只服务于旧下拉的样式（summary / 内嵌 pre）删掉，摘要条样式在位",
);
ok(
  /\.overlay-box\.dsh-think-pop-box/.test(DSH_CSS) &&
    /\.dsh-think-pop \{[\s\S]{0,120}?display: flex;/.test(DSH_CSS) &&
    /\.dsh-think-pop \{[\s\S]{0,200}?flex-direction: column;/.test(DSH_CSS) &&
    /\.dsh-think-pop-pane \{[\s\S]{0,200}?overflow: auto;/.test(DSH_CSS),
  "[6] 弹窗宽幅靠专属类、原文与译文**上下两个框**各自独立滚动（避免文字滚动影响浏览）",
);
ok(
  /openOverlay\(I18n\.t\("◉ 思考 · "\) \+ txt\.length/.test(ASSIST) &&
    /shell\.classList\.add\("dsh-think-pop-box"\)/.test(ASSIST) &&
    /dshThinkTranslateBtn\(txt, scopeId, segKey, txt\)/.test(ASSIST) &&
    /left\.tools\.appendChild\(cp\)/.test(ASSIST),
  "[6] 弹窗走 #overlay（近全屏 / 可最小化 / Esc 关），原文栏头挂「复制」+「翻译」",
);
ok(
  /function dshThinkPopPaintXlate\(scopeId, segKey\)/.test(ASSIST) &&
    /dshThinkPopPaintXlate\(scopeId, segKey\)/.test(ASSIST.split("async function dshTranslateThinking")[1] || ""),
  "[6] 弹窗里翻译沿用同一条按段缓存 + 校验链，且翻完就地刷新译文框（未点翻译时没有这一栏）",
);
has(DSH_CSS, ".dsh-seg-has-time {", "[6] 逐项时刻给每一项留出左侧定宽栏（不压正文）");
has(DSH_CSS, ".dsh-seg-has-time > .dsh-seg-time {", "[6] 时刻栏样式在位（等宽表格数字、恒显淡色）");
/* 时刻栏宿主自己不上色（用户口径「工具调用的颜色和左侧颜色竖条被错误地拉伸到了左边时间的
   左侧，应当与思考一致、不包括时间」）：带皮肤的段一律两层 —— 外层只当时刻栏宿主（透明），
   内层才是皮肤盒（思考 = details.dsh-seg-think、工具 = div.dsh-seg-tool）。
   青轨是 border-left、青底是 background，都以元素自己的左边框为起点：宿主兼皮肤时
   这个起点落在时刻栏左边，颜色就把时刻一起裹住了。 */
ok(
  (ASSIST.match(/box\.className = "dsh-seg dsh-seg-tool"/g) || []).length === 2 &&
    (ASSIST.match(/wrap\.className = "dsh-seg dsh-seg-tool-wrap"/g) || []).length === 2,
  "[6] 工具段的皮肤盒（.dsh-seg-tool）与时刻栏宿主（.dsh-seg-tool-wrap）**分两层**，历史 + 运行中两条路径都是",
);
ok(
  !/wrap\.className = "dsh-seg dsh-seg-tool"/.test(ASSIST),
  "[6] 不再有「时刻栏宿主兼皮肤」的写法（青轨 / 青底不会从时刻栏左边起画、把时刻裹进去）",
);
ok(
  /dshSegTimeAttach\(wrap, t && t\.at, t && t\.doneAt, msgAt\)/.test(ASSIST) &&
    /dshSegTimeAttach\(wrap, t\.at \|\| seg\.at, t\.doneAt, 0\)/.test(ASSIST) &&
    /const wrap = document\.createElement\("div"\);\s*\n\s*wrap\.className = "dsh-seg dsh-seg-tool-wrap";/.test(
      ASSIST,
    ),
  "[6] 工具项的时刻挂在**外层宿主**上（不是挂在青盒那一层）",
);
ok(
  /\.dsh-seg-tool-wrap > \.dsh-seg-tool \{\s*\n\s*margin: 0;/.test(DSH_CSS),
  "[6] dsh.css 钉住两层关系（内层皮肤盒 margin 归零，间距仍由外层让出）",
);
{
  const ti = DSH_CSS.indexOf("\n.dsh-seg-tool {");
  const tbox = ti < 0 ? "" : DSH_CSS.slice(ti, DSH_CSS.indexOf("}", ti));
  ok(
    /border-left:\s*2px solid var\(--cyan\)/.test(tbox) &&
      /background:\s*rgba\(56, 214, 255/.test(tbox),
    "[6] 青轨（border-left）与青底（background）确实长在内层盒上（所以颜色从时刻右侧开始）",
  );
}
/* 真跑逐项时刻：三种来源各判一次（自己的 at / 回落消息 at / 两处都没有） */
{
  const mkEl = (tag) => {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      children: [],
      parentNode: null,
      title: "",
      textContent: "",
      _cls: new Set(),
      classList: {
        add: (...c) => c.forEach((x) => el._cls.add(x)),
        remove: (...c) => c.forEach((x) => el._cls.delete(x)),
        contains: (c) => el._cls.has(c),
      },
      appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = el;
        el.children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = el;
        const i = ref ? el.children.indexOf(ref) : -1;
        if (i < 0) el.children.push(c);
        else el.children.splice(i, 0, c);
        return c;
      },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i >= 0) el.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      },
      get firstChild() {
        return el.children[0] || null;
      },
      addEventListener: () => {},
    };
    Object.defineProperty(el, "className", {
      get: () => Array.from(el._cls).join(" "),
      set: (v) => {
        el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
      },
    });
    return el;
  };
  const sb = {
    console,
    S: {},
    document: { createElement: (t) => mkEl(t) },
    I18n: { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) },
    /* 与 app-assist.js 同口径的两把时间格式化（真壳里就在同文件上方） */
    formatMsgTimeSec: (ts) => "T" + (Number(ts) || 0),
    formatMsgStamp: (ts) => "STAMP" + (Number(ts) || 0),
  };
  vm.createContext(sb);
  vm.runInContext(
    extract(ASSIST, ["dshSegDurText", "dshSegTimeEl", "dshSegTimeAttach"]),
    sb,
    { filename: "segtime.js" },
  );
  const Q2 = (code) => vm.runInContext(code, sb);
  ok(Q2("dshSegDurText(1000, 2500)") === "1.5s", "[6] 工具耗时 ≥1s 按秒给一位小数（1.5s）");
  ok(Q2("dshSegDurText(1000, 1300)") === "300ms", "[6] 工具耗时 <1s 按毫秒给（300ms）");
  ok(Q2("dshSegDurText(1000, 900)") === "" && Q2("dshSegDurText(0, 900)") === "", "[6] 没有结果 / 没有发起时刻就不编耗时");
  const own = Q2("__a = dshSegTimeEl(1000, 2500, 500); __a");
  ok(
    !!own && own.textContent === "T1000 · 1.5s" && !own.classList.contains("is-approx"),
    "[6] 有自己的时刻：只写自己的时刻 + 耗时（不带「≈」）：实得「" + (own ? own.textContent : "无") + "」",
  );
  ok(
    !!own && /这一项自己的时刻/.test(own.title) && /STAMP1000/.test(own.title) && /1\.5s/.test(own.title),
    "[6] tooltip 说明这是这一项自己的时刻（精确到秒）+ 完整时间戳 + 耗时",
  );
  const fb = Q2("__b = dshSegTimeEl(0, 0, 500); __b");
  ok(
    !!fb && /^T500$/.test(fb.textContent) && fb.classList.contains("is-approx"),
    "[6] 老存档没有段时刻 → 回落显示所属消息时刻、并打上 .is-approx（点线下划线 + 更淡；实得「" +
      (fb ? fb.textContent : "无") +
      "」）",
  );
  ok(
    !/≈/.test(fb ? fb.textContent : ""),
    "[6] 回落时刻不额外加「≈」字符（多一个字符会把最长形态挤出栏宽、时刻折成两行；真浏览器量过）",
  );
  ok(
    !!fb && /老存档/.test(fb.title) && /STAMP500/.test(fb.title),
    "[6] 回落时 tooltip 明说「不是这一项自己的时刻」（不拿顺序 / 轮号推算）",
  );
  ok(Q2("dshSegTimeEl(0, 0, 0)") === null, "[6] 两处时刻都拿不到 → 不挂空栏（返回 null）");
  const host = Q2("__h = document.createElement('div'); dshSegTimeAttach(__h, 1000, 2000, 0); __h");
  ok(
    !!host &&
      host.classList.contains("dsh-seg-has-time") &&
      !!host.children[0] &&
      host.children[0].classList.contains("dsh-seg-time"),
    "[6] 挂载口径：段元素加上 .dsh-seg-has-time，时刻栏是它的**第一只子节点**",
  );
  const host2 = Q2("__h2 = document.createElement('div'); dshSegTimeAttach(__h2, 0, 0, 0); __h2");
  ok(
    !!host2 && host2.children.length === 0 && !host2.classList.contains("dsh-seg-has-time"),
    "[6] 拿不到时刻的项一字不动（不留空栏、不加类）",
  );
}
/* 页脚动作行：样式收了「最新一轮常显、历史轮 hover 才现」（上游 turn-tail 口径） */
ok(
  /\.agent-list > \.dsh-msg:not\(:last-child\) \.dsh-msg-actions \{\s*\n\s*opacity: 0;/.test(DSH_CSS),
  "[6] 历史轮的页脚动作行默认隐去（hover / focus 才现）",
);
ok(
  /\.agent-list > \.dsh-msg:not\(:last-child\):hover \.dsh-msg-actions,/.test(DSH_CSS),
  "[6] 悬停该轮即显形",
);

/* =====================================================================
 * [7] 接线：样式令牌 / 设置 / 冒烟口径
 * ===================================================================== */
section("[7] 接线：令牌 / 设置 / i18n");
for (const tk of ["--dsh-diff-add:", "--dsh-diff-del:", "--dsh-diff-add-bg:", "--dsh-diff-del-bg:"]) {
  has(TOKENS, tk, "[7] 令牌层定义 " + tk);
}
ok(
  !/#[0-9a-f]{3,8}/i.test(TOKENS.slice(TOKENS.indexOf("--dsh-diff-add:"), TOKENS.indexOf("--dsh-shimmer:"))),
  "[7] diff 令牌不写死 hex（值由主题槽位混出，亮暗同源）",
);
has(DSH_CSS, ".dsh-diff-row.d-add {", "[7] diff 新增行样式在位");
has(DSH_CSS, "box-shadow: inset 3px 0 0 var(--dsh-diff-add);", "[7] 新增行 3px 内嵌左色条（上游 DiffBlock 口径）");
has(DSH_CSS, ".dsh-diff-row.d-del {", "[7] diff 删除行样式在位");
ok(
  /\.dsh-tool\.st-running \.dsh-tool-chip \{[\s\S]{0,300}?animation: dsh-tool-breathe/.test(DSH_CSS),
  "[7] 运行中的工具行只做边框呼吸灯（原来的底色扫光太闪，已撤）",
);
ok(
  /@keyframes dsh-tool-breathe \{[\s\S]{0,400}?border-color: color-mix/.test(DSH_CSS) &&
    !/dsh-tool-shimmer/.test(DSH_CSS),
  "[7] 呼吸的通道只有 border-color（没有背景图扫光）",
);
ok(
  /--dsh-tool-breath-dur:\s*[\d.]+s/.test(TOKENS) && /--dsh-tool-breath-lo:/.test(TOKENS),
  "[7] 呼吸节奏与深浅走令牌（亮暗同源，不写死 hex）",
);
ok(
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}?\.dsh-tool\.st-running \.dsh-tool-chip \{\s*\n\s*animation: none;/.test(
    DSH_CSS,
  ),
  "[7] 减少动效时停在静态边框色（不再呼吸）",
);
has(ASSIST, 'det.dataset.state = state;', "[7] 状态落在 data-state 上（DOM 契约，样式与冒烟都按它找）");
has(ASSIST, 'chip.dataset.toolName = String(t.name || "");', "[7] 原始工具名留在 dataset 上");
/* 非 dsh 工具那一档的专属色（本次需求）：药丸挂 .t-custom → 工具库紫，悬停 / 展开同步，
   亮色主题另给浅一档紫底（暗色那支 alpha 在浅底上偏脏）。 */
has(ASSIST, 'chip.className = "dsh-tool-chip" + (dshToolIsCustom(t) ? " t-custom" : "");', "[7] 药丸按 dshToolIsCustom 挂专属色类");
has(ASSIST, "chip.title = String(t.name || \"\") + (title && title !== t.name ? \" · \" + title : \"\");", "[7] 中文标签与原名不同才补 hover 后缀（不再出现「询问用户 · 询问用户」）");
has(DSH_CSS, ".dsh-tool-chip.t-custom {", "[7] 专属色类在位（药丸本体）");
has(DSH_CSS, ".dsh-tool-chip.t-custom:hover,", "[7] 专属色跟随悬停");
has(DSH_CSS, ".dsh-tool[open] .dsh-tool-chip.t-custom {", "[7] 专属色跟随展开态");
ok(
  /\.dsh-tool-chip\.t-custom \{[\s\S]{0,400}?color: #c792ea;/.test(DSH_CSS) &&
    /\.dsh-tool\.err \.dsh-tool-chip \{/.test(DSH_CSS),
  "[7] 专属色 = 工具库紫 #c792ea，且出错时仍被 .dsh-tool.err 那条红盖住（特异性更高）",
);
ok(
  /body\.theme-light \.dsh-tool-chip\.t-custom:hover/.test(LIGHT_CSS) &&
    /body\.theme-light \.dsh-tool\[open\] \.dsh-tool-chip\.t-custom \{/.test(LIGHT_CSS),
  "[7] 亮色主题同步专属色的悬停 / 展开底色（不再只给青色那档）",
);
has(DSH_CSS, ".dsh-tool-sum > :not(:first-child)::before {", "[7] 标题后的分隔圆点由 CSS 画（不额外占 DOM 节点）");
/* 设置：全局默认档位 */
has(BOOT, 'transcriptView: "standard",', "[7] 配置缺省档位 = standard");
has(
  SETTINGS,
  "工作步骤展示（新会话默认档位：简洁 = 不显示思考 / 标准 / 详细 / 完全展开 = 思考与工具卡都默认摊开；工具调用一律按时间线内联、不收纳；每会话还可在输入区「模式」菜单里用「显示思考」开关单独隐藏 / 显示思考）",
  "[7] 设置 · 智能能力里那一行在位（文案已按「不收纳过程行 + 会话里改走显示思考开关」改口径）",
);
has(SETTINGS, "dshEls.transcriptView = tvSel;", "[7] 设置行登记进 dshEls（关窗收口一起写盘）");
ok(
  /transcriptView: dshEls\.transcriptView\s*\n?\s*\? dshTranscriptViewNorm\(dshEls\.transcriptView\.value\) \|\| DSH_TRANSCRIPT_DEFAULT/.test(
    SETTINGS,
  ),
  "[7] 关窗收口按选择框那一刻写盘",
);
/* i18n：本轮新增串逐条有英文 */
{
  const keys = [
    "显示思考",
    "简洁",
    "详细",
    "完全展开",
    "读取",
    "写入",
    "运行命令",
    "搜索文件内容",
    "查找文件",
    "网页搜索",
    "网页获取",
    "更新计划",
    "子智能体",
    /* 非 dsh 工具那一批（本次需求）：逐条要有英文（漏一条中文就会漏到英文界面） */
    "询问用户",
    "画布应用",
    "编辑画布",
    "数据库查询",
    "长任务状态",
    "浏览器启动",
    "浏览器快照",
    "浏览器导航",
    "浏览器点击",
    "浏览器输入",
    "浏览器按键",
    "浏览器取值",
    "浏览器等待",
    "浏览器截图",
    "浏览器标签页",
    "浏览器网络",
    "浏览器求助",
    "浏览器释放",
    "建目标",
    "读目标",
    "改目标",
    "派生子智能体",
    "列出子智能体",
    "发消息",
    "中断子智能体",
    "列出后台任务",
    "读取后台任务",
    "终止后台任务",
    "正在准备内容 {n} KB",
    "已停止",
    "本次改动：新增 {a} 行，删除 {r} 行",
    "… 其余 {n} 行",
    "收起差异",
    "上下文注入",
    "已添加工具：",
    "；已移除工具：",
    "新增 {n} 个工具",
    "移除 {n} 个工具",
    "新增 {a} 个，移除 {r} 个",
    "上下文发生了变化（工具集增删）。普通上下文注入与系统提示按上游口径不显示。",
    "，用时 ",
    "{n} 次工具调用",
    "展开 / 收起这一轮的过程（思考与工具调用）",
  ];
  const miss = [];
  I18n.setLocale("en");
  for (const k of keys) {
    const en = I18n.t(k);
    if (!en || en === k || /[\u4e00-\u9fa5]/.test(en)) miss.push(k);
  }
  ok(miss.length === 0, "[7] i18n(en) 覆盖本轮每一条新串（" + keys.length + " 条）" + (miss.length ? " 缺：" + miss.join(" / ") : ""));
  I18n.setLocale("zh");
  ok(I18n.t("正在准备内容 {n} KB", { n: 3 }) === "正在准备内容 3 KB", "[7] 中文占位符照常插值");
}

/* =====================================================================
 * [8] 轨迹 View（会话头部「对话 / 轨迹」标签 + 主区轨迹 + 检查器）
 * ===================================================================== */
section("[8] 轨迹 View（本次需求 · 上游 conversation.view / ui-trajectory 口径）");
{
  const TRAJ = read("renderer/app-trajectory.js");
  has(TRAJ, 'tabsEl.className = "dsh-view-tabs agent-view-tabs";', "[8] 复用 dsh-tokens 的 View 标签栏皮");
  has(TRAJ, 'tabsEl.id = "agentViewTabs";', "[8] 标签栏宿主有稳定 id");
  ok(
    /mk\("chat", T\("对话"\)\)[\s\S]{0,200}?mk\("trace", T\("轨迹"\)\)[\s\S]{0,200}?mk\("changes", T\("改动"\)\)/.test(
      TRAJ,
    ) &&
      /function T\(s\) \{[\s\S]{0,200}?I18n\.t\(s\)/.test(TRAJ),
    "[8] 三枚标签 = 对话 / 轨迹 / 改动（走 i18n，中英成对）",
  );
  ok(
    /const VIEWS = \["chat", "trace", "changes"\];/.test(TRAJ) &&
    /function viewOf\(st\) \{[\s\S]{0,200}?VIEWS\.indexOf\(v\) > 0 \? v : "chat";/.test(TRAJ) &&
    /st\.trajView = VIEWS\.indexOf\(String\(v\)\) > 0 \? String\(v\) : "";/.test(TRAJ),
    "[8] 视图选择落在会话语义上（st.trajView ∈ chat / trace / changes），非法值回对话（上游「绝不选第一个 View」同读法）",
  );
  has(TRAJ, "if (typeof persistAgentSession === \"function\") persistAgentSession();", "[8] 选择随会话落盘（上游的持久化 View 偏好）");
  ok(!/ba-open/.test(TRAJ), "[8] 不再借右栏 .ba-open 显隐（右栏回归浏览器活动 + 文件预览）");
  has(TRAJ, 'mainEl.id = "agentTraceMain";', "[8] 轨迹渲染在会话主区（不是第三栏）");
  /* 本轮（横轴：全轴 + 滑窗带）：列表里那条 sticky 吸顶轴、列表外的旧总轴写法都已撤 ——
     现在只有**一条**轴：画整个会话，另用半透明滑窗带标出当前视窗那一段。 */
  ok(
    !/renderOverview/.test(TRAJ.replace(/\/\*[\s\S]*?\*\//g, " ")) &&
      !/dsh-trace-overview/.test(TOKENS),
    "[8] 旧的「总时间轴」写法（renderOverview / .dsh-trace-overview）不再存在",
  );
  has(TRAJ, 'inspEl.className = "dsh-trace-insp";', "[8] 检查器一栏");
  has(TRAJ, 'gutter.className = "dsh-trace-ln";', "[8] 检查器代码块带行号槽");
  has(TRAJ, "fileviewHighlight", "[8] 代码块复用右侧文件面板的词法高亮（不另起一套）");
  has(TRAJ, "if (!devOn()) {", "[8] 检查器受设置·开发者工具约束（标签本身常显）");
  has(TRAJ, "const ticks = document.createElement(\"div\");", "[8] 窗口轴带刻度行");
  /* 主区接线：会话每次重绘同步一次（轮询只是兜底） */
  has(ASSIST, "if (window.MTNodeTrajectory && typeof MTNodeTrajectory.sync === \"function\")", "[8] renderAgentSession 主路径调 sync");
  /* 落盘白名单与重启水合都要认「改动」这第三档（只落非默认态，其余一律回对话）：
     判据与 app-trajectory.js 的 VIEWS 同一份口径，两处少一处就会出现「切回改动栏却回到了对话」。 */
  has(
    ASSIST,
    'trajView: s.trajView === "trace" || s.trajView === "changes" ? s.trajView : "",',
    "[8] 落盘白名单带上 trajView（trace / changes 两种非默认态，其余回对话）",
  );
  has(
    BOOT,
    'sess.trajView = sess.trajView === "trace" || sess.trajView === "changes" ? sess.trajView : "";',
    "[8] 重启水合归一 trajView（同样认改动档）",
  );
  /* 右栏那一格交还给浏览器活动 / 文件预览 */
  ok(!/\.dsh-trace-col\s*\{/.test(TOKENS), "[8] 旧的「右栏轨迹栏」样式已撤（不再与浏览器活动互斥抢占）");
  for (const cls of [".dsh-trace-main {", ".dsh-trace-cols {", ".dsh-trace-insp {", ".dsh-trace-code {", ".dsh-trace-mark {"]) {
    has(TOKENS, cls, "[8] dsh-tokens.css 有 " + cls);
  }
  ok(
    /\.dsh-trace-ruler \{[\s\S]{0,800}?height: var\(--dsh-trace-ruler-h\);/.test(TOKENS) &&
      /\.dsh-trace-ruler-plot \{/.test(TOKENS) &&
      /\.dsh-trace-window \{/.test(TOKENS) &&
      /\.dsh-trace-window \{[\s\S]{0,400}?pointer-events: none;/.test(TOKENS),
    "[8] 窗口轴是恒定高度的一行（3 轨），带绘图区与滑窗带样式（带不吃指针事件）",
  );
  has(I18N_SRC, '"轨迹": "Trajectory"', "[8] i18n 补「轨迹」英文词条");
}

/* =====================================================================
 * [9] 输入区标记（上下文圆环已移除 / Todo 三态 / 排队与插话分区）
 * ===================================================================== */
section("[9] 输入区标记（上下文圆环已移除 · Todo dock / QueueDock 口径）");
/* 本次需求：输入卡片下方那枚「上下文已用 0 / 1.0M tok」圆环整只摘掉（与 Token 报告重复）。
   反向钉住：函数 / DOM 宿主 / 样式 / 词条 / 点击委托一处都不许留。 */
ok(!/renderAgentContextMeter/.test(ASSIST), "[9] 上下文占用圆环渲染器已整体移除（app-assist.js 无 renderAgentContextMeter）");
ok(!/agentCtxMeter|"agentCtx"|#agentCtx\b/.test(ASSIST.replace(/\/\*[\s\S]*?\*\//g, "")), "[9] app-assist.js 不再造 #agentCtxMeter / #agentCtx（注释里的痕迹不算）");
ok(!/agentCtx/.test(BOOT), "[9] app-boot.js 不再挂 #agentCtx 的点击委托（圆环没了就没有可点的宿主）");
ok(!/上下文已用/.test(I18N_SRC), "[9] i18n 词条「上下文已用 」已撤（词条随宿主一起走）");
for (const cls of [".agent-ctx-meter", ".acm-ring", ".acm-track", ".acm-fill", ".acm-pct", ".acm-text", ".agent-ctx {"]) {
  ok(DSH_CSS.indexOf(cls) < 0, "[9] dsh.css 已无 " + cls + " 样式");
}
/* 报告侧必须原样在位：token 报告是移除后唯一的用量出口，别在清理时误伤 */
has(ASSIST, "renderSessionFooterStat", "[9] 会话脚部 token 报告仍在（用量唯一出口）");
has(APP_AGENT, "function tokMergeRun(owner, metrics, opts)", "[9] Token 报告入账器（app-agent.js 的 tokMergeRun）一字未动");
has(APP_AGENT, "function tokViewRounds(owner)", "[9] Token 报告逐轮明细（tokViewRounds）一字未动");
/* Todo 三态标记（上游 idle / ongoing / done markers）
   上游口径（dsh-client-ui-primitives 0.2.0-rc.2 的 StateDot）：清单行用 appearance="dot"，
   done 只是 data-state 上色的实心圆点；IconCheck 只出现在 appearance="step"（计划步骤）。
   所以「已完成」钉的是实心圆 —— 别改成勾。 */
has(ASSIST, "const TODO_MARK_CLASS = {", "[9] 状态 → 标记类名的唯一映射表");
has(ASSIST, 'ic.className = "at-dot m-" + (TODO_MARK_CLASS[t.status] || "pending");', "[9] 清单行改用形状标记（不叠 .at-icon：它的 font-size:12px 会把标记的 font-size:0 顶掉，字形就冒出来）");
ok(
  /function renderAgentTodoPanel\(st\)[\s\S]*?ic\.className = "at-dot m-"/.test(ASSIST) &&
    !/ic\.className = "at-icon at-dot/.test(ASSIST),
  "[9] 形状标记不再与字符标记类共存（叠在一起 = 绿点里再压一枚 ✓）",
);
has(ASSIST, 'ic.setAttribute("aria-label", I18n.t(TODO_LABEL[t.status] || TODO_LABEL.pending));', "[9] 形状标记仍带无障碍文本");
ok(
  /\.at-icon\.at-dot \{[\s\S]{0,400}?font-size: 0;/.test(DSH_CSS),
  "[9] 标记选择器带 .at-icon 前缀（特异度压过同文件后面的 .at-icon，历史 DOM 也兜得住）",
);
has(DSH_CSS, ".at-dot.m-pending::before {", "[9] 待处理 = 空心圆");
has(DSH_CSS, ".at-dot.m-done::before {", "[9] 已完成 = 实心圆（success 色）");
has(DSH_CSS, ".at-dot.m-active::before {", "[9] 进行中 = 旋转 loader（上游唯一非圆点的一档）");
ok(
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?\.at-dot\.m-active::before \{[\s\S]{0,120}?animation: none;/.test(
    DSH_CSS,
  ),
  "[9] 减少动效时 loader 退化为静态圈",
);
has(DSH_CSS, ".at-dot.m-unknown::before {", "[9] 未确认 = 描边圆（warn 色）");
/* 排队与插话分区（上游 QueueDock：pending-steering 与排队分开） */
has(ASSIST, "function agentPendingSteers(st)", "[9] 待生效插话的取数口径在位");
ok(
  /m\._kind !== "steer"[\s\S]{0,80}?m\._steerState === "in"[\s\S]{0,80}?continue;/.test(ASSIST),
  "[9] 已注入（in）的不再算待生效",
);
has(ASSIST, 'sec.className = "aq-sec aq-sec-steer";', "[9] 插话单独一区");
has(ASSIST, 'sec.className = "aq-sec aq-sec-queue";', "[9] 排队单独一区");
has(DSH_CSS, ".aq-sec + .aq-sec {", "[9] 两区之间有间距");
has(DSH_CSS, ".aq-sec-steer .aq-label {", "[9] 插话区用 warn 色标注（与排队的蓝区分）");

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-session-markers)",
);

/* ==================== 已并入：test/smoke-session-answer-context.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-answer-context.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
  const show = (v) => JSON.stringify(v);
  const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
  const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

  /* 从源码里按名字抠出顶层函数体（口径同 test/smoke-session-steer-pause.js） */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nlet " + name + "\\s*=", "m"),
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
    if (/^(async\s+)?function/.test(src.slice(at, at + 14))) {
      const i = src.indexOf("{", at);
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
    const start = iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
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

  const dbSrc = read("renderer/app-db.js");
  const assistSrc = read("renderer/app-assist.js");
  const i18nSrc = read("renderer/i18n.js");

  /* =====================================================================
   * [1] 询问窗答案落库：真跑抠出来的函数
   * ===================================================================== */
  console.log("\n[1] 询问窗答案落进会话消息（真跑 app-db.js 的真实函数）");
  const ANSWER_FNS = [
    "ixAnswerSessionOf",
    "ixAnswerPairsOf",
    "ixAnswerBubbleText",
    "ixCommitAnswerToSession",
    "agentHistoryEntries",
    "agentConfirmedHistoryEntries",
  ];
  const fnsSrc = ANSWER_FNS.map((n) => fnBody(dbSrc, n)).join("\n");
  /* 真词条：直接 require renderer/i18n.js（它是 UMD，node 下走 module.exports）——
     vm 里的 I18n 用真表，落库正文里的「（未作答）」等文案与界面上的一字不差。 */
  const I18n = require("../renderer/i18n.js");
  const persisted = [];
  const sessions = [
    { id: "as-1", messages: [], updatedAt: 0 },
    { id: "as-2", messages: [], updatedAt: 0 },
  ];
  let activeAgentId = "as-1";
  const sandbox = {
    I18n: I18n,
    activeAgentId: () => activeAgentId,
    agentSessionById: (id) => sessions.find((s) => s.id === id) || null,
    persistAgentSession: () => {
      persisted.push(Date.now());
      return Promise.resolve();
    },
    sessionIsRunning: () => false,
    agentViewIs: () => false,
    renderAgentSession: () => {},
    renderAgentSessionSidebar: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fnsSrc +
      "\n;globalThis.__ix = { ixAnswerSessionOf, ixAnswerPairsOf, ixAnswerBubbleText, ixCommitAnswerToSession, agentHistoryEntries, agentConfirmedHistoryEntries };",
    sandbox,
  );
  const IX = sandbox.__ix;

  const card = {
    runKey: "agent:as-1",
    data: {
      id: "ix-1",
      sessionId: "session-abc",
      questions: [
        { id: "q1", question: "范围怎么定？", options: [{ label: "只改渲染层" }, { label: "含网关" }] },
        { id: "q2", question: "要不要开关？", options: [{ label: "不加开关" }] },
        { id: "q3", question: "备注？", options: [{ label: "A" }] },
      ],
    },
  };
  const answers = [
    { id: "q1", selected: ["只改渲染层"] },
    { id: "q2", selected: ["不加开关"] },
    { id: "q3", selected: [] },
  ];
  eqNum(IX.ixAnswerSessionOf(card).id, "as-1", "runKey=agent:<id> 能定位到那条会话");
  eqNum(
    IX.ixAnswerSessionOf({ runKey: "", data: {} }).id,
    "as-1",
    "runKey 为空时回落到当前活动会话（不丢这条回答）",
  );
  const pairs = IX.ixAnswerPairsOf(card, answers);
  eqNum(pairs.length, 3, "三题都有对应记录");
  eqNum(pairs[0].a, "只改渲染层", "选项答案按 label 成形");
  eqNum(pairs[2].a, "", "未勾选 / 未手填的题答案为空");
  const bubble = IX.ixAnswerBubbleText(pairs);
  has(bubble, "范围怎么定？", "气泡正文含题面");
  has(bubble, "只改渲染层", "气泡正文含所选答案");
  has(bubble, "（未作答）", "未作答的题在气泡里明确标出（不静默吞掉）");
  ok(bubble.split("\n").length === 4, "气泡 = 标题 + 三行「题 → 答」（得到 " + bubble.split("\n").length + " 行）");

  IX.ixCommitAnswerToSession(card, answers);
  eqNum(sessions[0].messages.length, 1, "答案写进目标会话（as-1）");
  eqNum(sessions[1].messages.length, 0, "别的会话一个字都不加");
  eqNum(sessions[0].messages[0].role, "user", "以用户消息身份落库（界面即用户气泡）");
  eqNum(sessions[0].messages[0]._src, "ix-answer", "标记 _src=ix-answer（供之后按题 id 去重）");
  eqNum(show(sessions[0].messages[0]._ixQids), show(["q1", "q2", "q3"]), "记录题 id（同一题重答只留最新）");
  ok(persisted.length >= 1, "落库即持久化（persistAgentSession 被调用）");
  /* 手填优先：custom 与 selected 同源（ixAnswerQuestion 已把 custom 放进 selected） */
  const customAns = [{ id: "q1", selected: ["我自己写的答案"], custom: "我自己写的答案" }];
  has(IX.ixAnswerBubbleText(IX.ixAnswerPairsOf(card, customAns)), "我自己写的答案", "手填答案原样进气泡");

  /* =====================================================================
   * [2] 会话历史段：去重 + 上限
   * ===================================================================== */
  console.log("\n[2] 会话历史段 agentHistoryEntries（去重 / 上限）");
  const baseMsgs = [
    { role: "user", content: "第一句", at: 1 },
    { role: "assistant", content: "回复一", at: 2 },
    { role: "user", content: "第一句", at: 3 },
    { role: "assistant", content: "回复二", at: 4 },
    { role: "user", content: "本轮最新", at: 5 },
  ];
  const hist = IX.agentHistoryEntries({ messages: baseMsgs });
  eqNum(hist.length, 3, "同文去重 + 默认去掉最后一条（= 本轮输入）");
  eqNum(show(hist.map((r) => r.text)), show(["第一句", "回复一", "回复二"]), "保留顺序与角色");
  const histAll = IX.agentHistoryEntries({ messages: baseMsgs }, { skipLast: false });
  eqNum(histAll.length, 4, "skipLast:false 时保留本轮那条");
  /* 回答气泡按题 id 取最新：同一题答两次，只留后一次 */
  const twice = [
    { role: "user", content: "【我对上面问题的回答】\n· q1 → 旧答案", _src: "ix-answer", _ixQids: ["q1"], at: 1 },
    { role: "user", content: "普通补充", at: 2 },
    { role: "user", content: "【我对上面问题的回答】\n· q1 → 新答案", _src: "ix-answer", _ixQids: ["q1"], at: 3 },
  ];
  const h2 = IX.agentHistoryEntries({ messages: twice }, { skipLast: false });
  eqNum(h2.length, 2, "同一题重答只留最新一次（旧气泡丢掉）");
  has(h2.map((r) => r.text).join("\n"), "新答案", "留下的是最新答案");
  ok(!/旧答案/.test(h2.map((r) => r.text).join("\n")), "旧答案不再重复进上下文");
  /* 任务书 kick 不进历史段（那份契约每轮随系统提示注入，不占用户输入） */
  const withKick = IX.agentHistoryEntries(
    {
      messages: [
        { role: "user", content: "【开发任务书】…很长的一段…", _src: "dev-node", at: 1 },
        { role: "user", content: "我的追问", at: 2 },
      ],
    },
    { skipLast: false },
  );
  eqNum(withKick.length, 1, "任务书 kick 不抄进历史段（避免白烧 token）");
  eqNum(withKick[0].text, "我的追问", "留下的只有真正的对话内容");
  /* 整段上限：超出从最早的丢 */
  const many = [];
  for (let i = 1; i <= 12; i++) many.push({ role: "user", content: "第" + i + "条-" + "x".repeat(50), at: i });
  const capped = IX.agentHistoryEntries({ messages: many }, { skipLast: false, maxChars: 200 });
  ok(capped.length < 12, "超过字符上限时截断（" + many.length + " → " + capped.length + "）");
  eqNum(capped[capped.length - 1].text, many[many.length - 1].content, "截断丢的是最早的，最新一条始终保留");

  /* =====================================================================
   * [3] 续跑兜底：只带用户侧确认过的东西
   * ===================================================================== */
  console.log("\n[3] 续跑兜底 agentConfirmedHistoryEntries");
  const sess3 = {
    messages: [
      { role: "user", content: "开发任务书 kick", _src: "dev-node", at: 1 },
      { role: "user", content: "【我对上面问题的回答】\n· q1 → A", _src: "ix-answer", _ixQids: ["q1"], at: 3 },
      { role: "assistant", content: "AI 的一大段回复", at: 4 },
      { role: "user", content: "我的补充说明", at: 5 },
      { role: "assistant", content: "AI 又一大段回复", at: 6 },
    ],
  };
  const conf = IX.agentConfirmedHistoryEntries(sess3);
  eqNum(conf.length, 2, "只留「回答气泡 + 用户消息」（AI 回复与任务书 kick 不进）");
  has(conf[0].text, "q1", "兜底段第一条 = 询问窗回答气泡");
  eqNum(conf[1].text, "我的补充说明", "兜底段第二条 = 用户自己发的补充");
  ok(!/AI 的一大段回复|任务书 kick/.test(conf.map((r) => r.text).join("\n")), "助手正文与 kick 都没被抄进兜底段");
  const confDedup = IX.agentConfirmedHistoryEntries({
    messages: [
      { role: "user", content: "【我对上面问题的回答】\n· q1 → 旧", _src: "ix-answer", _ixQids: ["q1"], at: 1 },
      { role: "user", content: "【我对上面问题的回答】\n· q1 → 新", _src: "ix-answer", _ixQids: ["q1"], at: 2 },
    ],
  });
  eqNum(confDedup.length, 1, "兜底段同样按题 id 去重取最新");
  has(confDedup[0].text, "新", "兜底段留下的是最新答案");

  /* =====================================================================
   * [4] 源码接线与词条
   * ===================================================================== */
  console.log("\n[4] 接线：提交成功才落库 / 追问不被 kick 覆盖 / 续跑兜底 / 词条");
  const thenBlock = dbSrc.slice(
    dbSrc.indexOf('.dshInteract({ kind: "question"'),
    dbSrc.indexOf('.dshInteract({ kind: "question"') + 700,
  );
  has(thenBlock, "ixCommitAnswerToSession(it, answers)", "提问提交的 then 里落库（进上下文）");
  has(thenBlock, "res.stale", "stale（该询问已失效）先返回、不落库");
  has(thenBlock, "res.ok === false", "失败回执抛出、不落库");
  ok(
    thenBlock.indexOf("ixCommitAnswerToSession") > thenBlock.indexOf("res.ok === false"),
    "落库发生在失败判定之后（失败 / 未提交一律不落）",
  );
  has(
    assistSrc,
    "if (devContractMsg && !t) {",
    "开发会话：只在文本为空时回落首条 kick（追问原样发出）",
  );
  ok(
    !/if \(devContractMsg\) \{\s*\n\s*const first/.test(assistSrc),
    "旧的「无条件覆盖 t」写法已消失（追问不再被第一条消息顶掉）",
  );
  has(assistSrc, "agentHistoryEntries({ messages: rbHistSrc }", "每轮 hist 走统一构造（含回答气泡）");
  has(assistSrc, "if (resumeRound && !sidKnown) {", "续跑轮判据不足时才补「已确认」段");
  has(assistSrc, "agentConfirmedHistoryEntries(st)", "续跑兜底段取用户侧确认记录");
  has(assistSrc, "不要重复提问", "兜底段带「不要重复提问」声明");
  has(assistSrc, "I18n.t(\"【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】\")", "声明文案走词条");

  /* 词条：中英两份（真加载 renderer/i18n.js，口径 = 英文界面不得回落中文） */
  const NEED = [
    "【我对上面问题的回答】",
    "（未作答）",
    "【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】",
  ];
  I18n.setLocale("zh");
  for (const k of NEED) {
    ok(I18n.t(k) === k, "中文界面原样回显（键即中文原文）：" + k);
  }
  I18n.setLocale("en");
  for (const k of NEED) {
    const en = I18n.t(k);
    ok(!!en && en !== k, "英文词条不是回落中文：" + k + " → " + en);
  }
  I18n.setLocale("zh");

  console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过（" + checks + " 项）"));
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-answer-context.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-answer-context.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-session-items.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-items.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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

  const ASSIST = read("renderer/app-assist.js");
  const SEARCH = read("renderer/app-search.js");

  /* ==================== [1] 常量与旧窗口清零 ==================== */
  console.log("\n[1] 条目窗口常量与旧的「按轮」窗口残留");
  ok(
    /const AGENT_MAX_VISIBLE_ITEMS = 200;/.test(ASSIST),
    "AGENT_MAX_VISIBLE_ITEMS = 200（每个会话最多同时渲染 200 条）",
  );
  ok(
    /const AGENT_LOAD_MORE_ITEMS = 200;/.test(ASSIST),
    "AGENT_LOAD_MORE_ITEMS = 200（点一次「显示更早内容」多展开 200 条）",
  );
  ok(
    ASSIST.indexOf("AGENT_MAX_VISIBLE_ROUNDS") < 0 &&
      ASSIST.indexOf("AGENT_LOAD_MORE_ROUNDS") < 0 &&
      ASSIST.indexOf("agentRoundSlice") < 0,
    "旧的按轮窗口（AGENT_MAX_VISIBLE_ROUNDS / agentRoundSlice）已删净",
  );
  ok(
    ASSIST.indexOf("_visRounds") < 0 && SEARCH.indexOf("_visRounds") < 0,
    "全仓不再有 _visRounds（渲染状态位改名 _visItems，不留半截旧状态）",
  );
  ok(
    ASSIST.indexOf("st._visItems = undefined;") > 0,
    "新一轮开跑把窗口重置回默认 200 条（更早的可重新展开）",
  );

  /* ==================== [2] agentEntrySlice 真源码行为 ==================== */
  console.log("\n[2] agentEntrySlice：条目预算怎么切窗口（跑真源码）");
  /* 只摘真源码：条目窗口段 + dshMsgSegsViewable（条目口径依赖它），不重写一份逻辑 */
  const segFrom = ASSIST.indexOf("function dshMsgSegsViewable(m) {");
  const segTo = ASSIST.indexOf("\n}\n", segFrom);
  const winFrom = ASSIST.indexOf("const AGENT_MAX_VISIBLE_ITEMS = 200;");
  const winTo = ASSIST.indexOf("/* 写剪贴板：");
  ok(segFrom > 0 && segTo > segFrom, "摘到 dshMsgSegsViewable 真源码");
  ok(winFrom > 0 && winTo > winFrom, "摘到条目窗口真源码");
  const sb = { Math, console };
  vm.createContext(sb);
  const api = vm.runInNewContext(
    ASSIST.slice(segFrom, segTo + 3) +
      "\n" +
      ASSIST.slice(winFrom, winTo) +
      "\n({ agentEntryCount, agentEntrySlice, agentEntryBudgetFrom, AGENT_MAX_VISIBLE_ITEMS, AGENT_LOAD_MORE_ITEMS, dshMsgSegsViewable })",
    sb,
  );
  ok(api.AGENT_MAX_VISIBLE_ITEMS === 200, "vm 里拿到的上限就是 200");

  /* 工具函数：造一条能按段渲染的 assistant 消息（say 段拼起来正好等于 content） */
  function segMsg(n, role) {
    const segs = [];
    for (let i = 0; i < n; i++) segs.push({ k: "say", text: "第" + i + "段" });
    return { role: role || "assistant", content: segs.map((s) => s.text).join("\n\n"), segments: segs };
  }
  function plainMsg(role) {
    return { role: role || "user", content: "你好" };
  }
  const U = (role) => plainMsg(role);

  /* 普通消息：每条 1 条 → 500 条只渲染最后 200 条 */
  const s1 = { messages: [] };
  for (let i = 0; i < 500; i++) s1.messages.push(U());
  let r1 = api.agentEntrySlice(s1);
  ok(api.agentEntryCount(U()) === 1, "普通消息整条算 1 条条目");
  ok(r1.total === 500, "500 条消息 = 500 条条目");
  ok(r1.shown === 200 && r1.start === 300, "窗口从第 300 条起，正好渲染 200 条");
  ok(r1.total - r1.shown === 300, "「显示更早内容」要说明折叠了 300 条");

  /* 段消息：每个段 1 条 → 3 条 × 100 段 = 300 条 → 从第 1 条消息起 */
  const s2 = { messages: [segMsg(100), segMsg(100), segMsg(100)] };
  const r2 = api.agentEntrySlice(s2);
  ok(r2.total === 300, "3 条消息各 100 段 = 300 条条目（段才是真正的渲染块）");
  ok(r2.shown === 200 && r2.start === 1 && r2.skip === 0, "整条消息能装下就整条进窗口（起点=第 1 条）");
  ok(r2.total - r2.shown === 100, "折叠计数按段算：100 条");

  /* 边界：最新一条自己就超预算 → 只留它的尾部段，前面的段由按钮展开 */
  const s3 = { messages: [U(), segMsg(100), segMsg(300)] };
  const r3 = api.agentEntrySlice(s3);
  ok(r3.start === 2 && r3.skip === 100, "最新一条 300 段 > 200：只渲染尾部 200 段（跳过前 100 段）");
  ok(r3.shown === 200 && r3.shown <= api.AGENT_MAX_VISIBLE_ITEMS, "渲染条目数严格不超过 200");
  ok(r3.total - r3.shown === 201, "折叠计数 = 1 条用户消息 + 100 条被裁的段 = 201");

  /* 点一次「显示更早内容」：预算 +200 */
  const s4 = { messages: s3.messages.slice(), _visItems: r3.vis + api.AGENT_LOAD_MORE_ITEMS };
  const r4 = api.agentEntrySlice(s4);
  ok(r4.shown > r3.shown && r4.shown <= 400, "点一次展开后窗口变大（+200 条预算）");
  ok(r4.total - r4.shown === 1, "预算 400 时只剩最前面那条用户消息没进来");
  ok(r4.start === 1 && r4.skip === 0, "起点回到第 1 条消息，段不再被裁");

  /* 空会话 / 预算大于总量：不出按钮、全部可见 */
  const r5 = api.agentEntrySlice({ messages: [] });
  ok(r5.total === 0 && r5.shown === 0, "空会话：0 条条目（隐藏数 0，不出按钮）");
  const r6 = api.agentEntrySlice({ messages: [segMsg(3), U()] });
  ok(r6.start === 0 && r6.total === r6.shown, "条目总数 ≤ 200 时整段进窗口（不折叠）");

  /* ==================== [3] 搜索跳转的条目预算 ==================== */
  console.log("\n[3] agentEntryBudgetFrom：跳转旧消息必落在窗口内");
  const s7 = { messages: [U(), segMsg(120), segMsg(120), U()] };
  for (const target of [0, 1, 2, 3]) {
    const st = { messages: s7.messages.slice(), _visItems: api.agentEntryBudgetFrom(s7, target) };
    const r = api.agentEntrySlice(st);
    ok(r.start <= target, "跳转到第 " + target + " 条消息：窗口起点 " + r.start + " ≤ 目标");
  }
  ok(
    api.agentEntryBudgetFrom(s7, 0) === 1 + 120 + 120 + 1,
    "从第 0 条起所需预算 = 其后全部条目数（口径与窗口一致）",
  );
  ok(
    /agentEntryBudgetFrom/.test(SEARCH) && SEARCH.indexOf("_visRounds") < 0,
    "app-search.js 的会话跳转改用条目预算（不再放宽「轮数」）",
  );

  /* ==================== [4] 渲染接线 ==================== */
  console.log("\n[4] renderAgentSession / dshMsgBlock 接线");
  ok(
    /if \(hiddenEntries > 0\) \{/.test(ASSIST) &&
      /const hiddenEntries = Math\.max\(0, slice\.total - slice\.shown\);/.test(ASSIST),
    "只有「折叠数 > 0」才渲染最前端的展开按钮（≤200 条时界面与以前一样干净）",
  );
  ok(
    ASSIST.indexOf('I18n.t("显示更早内容（已折叠 {n} 条）", { n: hiddenEntries })') > 0,
    "按钮文案就是「显示更早内容」（带折叠条数）",
  );
  ok(
    /st\._visItems = slice\.vis \+ AGENT_LOAD_MORE_ITEMS;/.test(ASSIST) &&
      /renderAgentSession\(\);\n\s*const l2 = \$\("#agentList"\);/.test(ASSIST),
    "点击后 +200 条并就地重绘（保留滚动锚点，不跳回顶部）",
  );
  ok(
    /segFrom: i === slice\.start \? slice\.skip : 0,/.test(ASSIST),
    "窗口起点那条消息把已裁段数传给 dshMsgBlock（segFrom）",
  );
  ok(
    /Math\.min\(Number\(opts && opts\.segFrom\) \|\| 0, m\.segments\.length\)/.test(ASSIST),
    "segFrom 夹在 [0, 段数] 内（坏数据不至于把整条消息渲染空）",
  );
  ok(
    (ASSIST.match(/dshSegToolAt\(/g) || []).length >= 3,
    "工具段配对只用 dshSegToolAt 一处口径（定义 + 段渲染 + 被裁段对账）",
  );
  ok(
    /for \(let n = 0; n < from; n\+\+\) \{\s*\n\s*const at = dshSegToolAt\(pool, m\.segments\[n\]\);/.test(
      ASSIST,
    ),
    "被裁掉的前置段先把对应工具从 pool 里认掉（否则会从尾部兜底 chips 又冒出来一次）",
  );

  /* ==================== [5] 运行中那一轮同样封顶 ==================== */
  console.log("\n[5] 运行中的一轮：段预算同样封顶，且流式就地更新的段序不错位");
  ok(
    /const off = Math\.max\(0, items\.length - AGENT_MAX_VISIBLE_ITEMS\);/.test(ASSIST),
    "agentLiveSegsEl 只从最近 200 条起渲染（长任务跑到一半也不卡）",
  );
  ok(
    /for \(let i = off; i < items\.length; i\+\+\) \{/.test(ASSIST),
    "循环用 items 的绝对序号（dataset.segIdx 与 agentLiveSegTail 的比对口径不错位）",
  );
  ok(
    ASSIST.indexOf('cut.className = "dsh-seg dsh-live-cut";') > 0 &&
      ASSIST.indexOf('I18n.t("已折叠更早的运行条目：{n}", { n: off })') > 0,
    "折叠时给一行说明（用户知道更早的运行条目去哪了）",
  );
  ok(
    !/dataset\.segIdx = String\(i \+ off\)/.test(ASSIST),
    "没有给 dataset.segIdx 再加偏移（i 本身就是绝对序号）",
  );

  /* ==================== [6] i18n 与样式 ==================== */
  console.log("\n[6] i18n 中英成对 + 暗 / 亮两套样式");
  const I18n = require("../renderer/i18n.js");
  const KEYS = [
    "显示更早内容（已折叠 {n} 条）",
    "每个会话最多同时渲染 200 条，点击展开更早的 200 条",
    "已折叠更早的运行条目：{n}",
  ];
  const I18N_SRC = read("renderer/i18n.js");
  I18n.setLocale("en");
  for (const k of KEYS) {
    const en = I18n.t(k, { n: 3 });
    ok(en !== k, "英文词条：" + k.slice(0, 16) + "…");
    if (k.indexOf("{n}") >= 0) ok(en.indexOf("3") >= 0, "占位符 {n} 在英文串里照常插值：" + k.slice(0, 16) + "…");
    ok(I18N_SRC.indexOf(JSON.stringify(k).slice(1, -1)) > 0, "i18n.js 收词条：" + k.slice(0, 14) + "…");
  }
  I18n.setLocale("zh");
  ok(I18n.t("显示更早内容（已折叠 {n} 条）", { n: 7 }).indexOf("显示更早内容") === 0, "中文口径就是「显示更早内容…」");
  ok(
    /\.dsh-live-cut \{[^}]*color:/.test(read("renderer/css/dsh.css")),
    "dsh.css 有 .dsh-live-cut 样式",
  );
  ok(
    /body\.theme-light \.dsh-live-cut \{/.test(read("renderer/css/theme-light.css")),
    "亮色主题也有对应规则（不继承暗色灰）",
  );
  ok(
    /\.agent-load-earlier \{/.test(read("renderer/css/dsh.css")),
    "展开按钮沿用既有 .agent-load-earlier 壳（样式不另起一套）",
  );

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-items)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-items.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-items.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
