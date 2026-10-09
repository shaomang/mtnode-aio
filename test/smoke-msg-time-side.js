"use strict";
/* 会话轮次时间（消息级时刻栏）回归：会话里**不再有**最左侧那一列消息时刻
 *   node test/smoke-msg-time-side.js
 *
 * 本次需求（用户口径）：**移除会话中轮次的时间（最左侧的时间，因为占用了会话空间）**。
 * 历史：每条消息曾在左侧挂一格悬浮时刻（渲染 = app-assist.js 的 dshMsgBlock 插 .dsh-msg-side
 * 并给消息打 .dsh-has-time；样式 = css/dsh.css 在消息左内边距里预留 84px 定宽栏 + 窄栏四档
 * 容器查询），以及「不占第二行」的旧形态（挂在 .dsh-msg-tail 里）。这两处本轮一并移除。
 * 保留（不受本需求影响）：消息内部**逐项**时刻（.dsh-seg-has-time > .dsh-seg-time）——
 * 它在消息正文内、位于原消息级时刻栏的右侧一层，不属于「轮次的时间」。
 *
 * 被测真源（一个都不重写）：
 *   · renderer/app-assist.js            —— dshMsgBlock 真在 vm 里跑出 DOM 判定（不挂时刻栏）
 *   · renderer/css/dsh.css              —— 消息级时刻规则已删干净 + 逐项时刻规格未动
 *   · test/_preview-seg-time.html       —— 真样式预览夹具与现口径一致
 *
 * 覆盖：
 *   [1] 真渲染：带 at 的消息不挂 .dsh-msg-side / 不带 .dsh-has-time / 正文一字不少
 *   [2] 真渲染：末尾也不再压一行时刻（AI 的「复制本条回复」仍在 tail 里）
 *   [3] 源码口径：消息级时刻的渲染代码已整体摘掉，时刻格式化函数仍留着给别人用
 *   [4] 样式口径：消息级预留 / 悬浮栏 / 四档容器查询全删，逐项时刻规格与容器查询声明未动
 *   [5] 夹具与手册：真样式预览不再造消息级时刻栏；手册写明该层已移除、逐项时刻保留
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

const ASSIST = read("renderer/app-assist.js");
const DSH_CSS = read("renderer/css/dsh.css");
const PREVIEW = read("test/_preview-seg-time.html");
const MANUAL = read("guides/manual/dsh.md");

/* ==================== 假 DOM（只够 dshMsgBlock 用） ==================== */
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    classList: null,
    appendChild(c) {
      if (c && c.parentNode) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i >= 0) el.children.splice(i, 0, c);
      else el.children.push(c);
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) {
      el["__attr_" + k] = v;
    },
    getAttribute(k) {
      return el["__attr_" + k] == null ? null : el["__attr_" + k];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  el.classList = {
    add(...cs) {
      for (const c of cs)
        if ((" " + el.className + " ").indexOf(" " + c + " ") < 0)
          el.className = (el.className + " " + c).trim();
    },
    remove(...cs) {
      for (const c of cs)
        el.className = (" " + el.className + " ")
          .split(" " + c + " ")
          .join(" ")
          .trim();
    },
    contains(c) {
      return (" " + el.className + " ").indexOf(" " + c + " ") >= 0;
    },
  };
  return el;
}
/* 深度优先收集（含自身）：按 class 找元素 */
function findAll(root, cls) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if ((" " + (n.className || "") + " ").indexOf(" " + cls + " ") >= 0) out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return out;
}
const hasClass = (el, cls) =>
  !!el && (" " + (el.className || "") + " ").indexOf(" " + cls + " ") >= 0;

/* ==================== [1][2] 真跑 dshMsgBlock ==================== */
console.log("\n[1] 真渲染：消息不再挂左侧时刻栏（.dsh-msg-side 一格都不出现）");

/* 切片 = 被测函数本体（时刻格式化 → 档位/分段判定 → dshMsgBlock，只切真源码、不改一字） */
const from = ASSIST.indexOf("/* 消息末尾时间：精确到秒（非今天自动带日期） */");
const to = ASSIST.indexOf("/* ── 会话条目窗口：每个会话最多同时渲染");
ok(from > 0 && to > from, "摘到 formatMsgTimeSec … dshMsgBlock 真源码段");
const BLOCK_SRC = ASSIST.slice(from, to);

const sandbox = {
  console,
  Date,
  Math,
  String,
  Number,
  Array,
  Object,
  JSON,
  Map,
  Set,
  setTimeout: () => 0,
  clearTimeout: () => {},
  /* 与本文件其余守卫同口径的替身：只替「与消息结构无关的下游」 */
  S: { config: { dsh: {} }, openDshTools: {} },
  I18n: { t: (k) => String(k) },
  document: {
    createElement: (t) => mkEl(t),
    addEventListener: () => {},
  },
  window: {},
  histMsgKey: (owner, i, m) => owner + ":" + i + ":" + String((m && m.role) || ""),
  dshThinkShownFor: () => true,
  renderMarkdown: (t) => "<p>" + String(t == null ? "" : t) + "</p>",
  plainTextToLinkHtml: (t) => String(t == null ? "" : t),
  fmtDur: (n) => String(n) + "ms",
  dshToolDetailsEl: () => mkEl("details"),
  dshTurnProcessFold: () => null,
  dshHistSegEl: () => null,
  dshCopyBtn: (m, cls) => {
    const b = mkEl("button");
    b.className = cls || "dsh-msg-copy";
    return b;
  },
  dshMsgActionBar: () => mkEl("div"),
};
vm.createContext(sandbox);
const api = vm.runInNewContext(
  BLOCK_SRC + "\n({ dshMsgBlock, dshMsgSegsViewable, dshPolicyOfView, formatMsgTimeSec, formatMsgStamp })",
  sandbox,
);
ok(
  typeof api.dshMsgBlock === "function" &&
    typeof api.dshMsgSegsViewable === "function" &&
    typeof api.dshPolicyOfView === "function",
  "dshMsgBlock / dshMsgSegsViewable / dshPolicyOfView 取到",
);

/* 定一个**今天的此刻**当时间戳：formatMsgTimeSec 今天只回 HH:MM:SS
   （必须取当天，跨天跑会回「M/D HH:MM:SS」，不能钉死某个日期） */
const AT = Date.now() - 1000;
const TIME_TXT = api.formatMsgTimeSec(AT);
ok(/^\d{2}:\d{2}:\d{2}$/.test(TIME_TXT), "时刻格式化未动（今天 = HH:MM:SS）：" + TIME_TXT);

const aiRow = api.dshMsgBlock(
  { role: "assistant", content: "你好", at: AT },
  "assist",
  0,
  {},
);
const tails = findAll(aiRow, "dsh-msg-tail");
const bodies = findAll(aiRow, "dsh-msg-body");
ok(
  findAll(aiRow, "dsh-msg-side").length === 0,
  "带 at 的 AI 消息**不挂** .dsh-msg-side（最左侧那一列时间已移除）",
);
ok(!hasClass(aiRow, "dsh-has-time"), "消息不带 .dsh-has-time（样式不再为时刻留左侧余量）");
ok(
  findAll(aiRow, "dsh-msg-time").length === 0,
  "整条消息里一个 .dsh-msg-time 都没有（消息级时刻彻底摘掉）",
);
ok(
  bodies.length === 1 && /你好/.test(bodies[0].innerHTML),
  "正文照旧渲染（没有时刻也不许丢正文）",
);
/* 消息自己的时刻值确实取得到（AT 今天有 HH:MM:SS），说明「不挂」是渲染层面的决定、不是拿不到值 */
ok(!!TIME_TXT, "时刻值本身仍算得出来（移除的是渲染，不是格式化能力）");

console.log("\n[2] 真渲染：末尾也不再压一行时刻；AI 的「复制本条回复」仍在");
const userRow = api.dshMsgBlock({ role: "user", content: "提问", at: AT }, "assist", 1, {});
ok(
  findAll(userRow, "dsh-msg-side").length === 0 &&
    findAll(userRow, "dsh-msg-time").length === 0,
  "用户消息同一条路径：也没有任何时刻（用户 / AI 一致）",
);
const noTs = api.dshMsgBlock({ role: "assistant", content: "无时间戳" }, "assist", 2, {});
ok(
  findAll(noTs, "dsh-msg-side").length === 0 && !hasClass(noTs, "dsh-has-time"),
  "老消息（无 at）同样一字不挂（与有时刻的消息形态一致）",
);
const tailTimes = tails.reduce((n, t) => n + findAll(t, "dsh-msg-time").length, 0);
ok(tailTimes === 0, "消息末尾的时间行依旧没有时刻（旧形态没有回潮）");
ok(
  tails.length >= 1 && findAll(tails[0], "dsh-msg-tail-copy").length === 1,
  "AI 回复末尾的小「复制本条回复」仍在 tail 里（动作按钮不受本需求影响）",
);

/* ==================== [3] 源码口径 ==================== */
console.log("\n[3] 源码口径：消息级时刻的渲染代码已整体摘掉");
/* 去掉注释再找：说明「这次删了什么」的注释里会提到旧类名，那不算残留代码 */
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ASSIST_CODE = stripJs(ASSIST);
ok(
  ASSIST_CODE.indexOf("dsh-msg-side") < 0 && ASSIST_CODE.indexOf("dsh-has-time") < 0,
  "app-assist.js 去掉注释后，dsh-msg-side / dsh-has-time 一个都不剩（渲染与类名清干净）",
);
ok(
  !/const endTxt = formatMsgTimeSec\(/.test(ASSIST_CODE),
  "不再为消息算「末尾时刻」（endTxt 这条旧路径已删）",
);
ok(
  !/row\.appendChild\(side\)/.test(ASSIST_CODE) && !/tail\.appendChild\(tEl\)/.test(ASSIST_CODE),
  "既没有「挂左侧时刻栏」也没有「往 tail 追加时刻」两条旧路径",
);
ok(
  /function formatMsgTimeSec\(ts\)/.test(ASSIST) &&
    /function formatMsgStamp\(ts\)/.test(ASSIST),
  "formatMsgTimeSec / formatMsgStamp 仍保留（逐项时刻与卡片时间还在用）",
);
const segUses = (ASSIST.match(/formatMsgTimeSec\(/g) || []).length;
const stampUses = (ASSIST.match(/formatMsgStamp\(/g) || []).length;
ok(
  segUses >= 2 && stampUses >= 2,
  "两枚格式化函数仍被别处调用（逐项时刻 + 卡片时间）：formatMsgTimeSec×" +
    segUses +
    " · formatMsgStamp×" +
    stampUses,
);
ok(
  /tail\.className = "dsh-msg-tail";/.test(ASSIST) &&
    /if \(m\.role === "assistant"\) \{/.test(ASSIST),
  "末尾按钮行的出现条件不变（只看「AI 回复」，不留空行）",
);

/* ==================== [4] 样式口径 ==================== */
console.log("\n[4] 样式口径：消息级预留全删；逐项时刻规格与容器查询声明未动");
const sideStart = DSH_CSS.indexOf("/* ── 会话消息不再有「消息级时刻」栏");
const sideEnd = DSH_CSS.indexOf("/* ── dsh 风格消息流(透明背景)");
ok(sideStart > 0 && sideEnd > sideStart, "dsh.css 里有「消息级时刻已移除」的说明段");
const sideBlock = sideStart > 0 && sideEnd > sideStart ? DSH_CSS.slice(sideStart, sideEnd) : "";
ok(
  /container-type:\s*inline-size/.test(sideBlock) &&
    /\.agent-body,\s*\n\.agent-conv,\s*\n\.ltg-conv \{\s*\n\s*container-type: inline-size/.test(
      sideBlock,
    ),
  "会话容器的 container-type: inline-size 保留（逐项时刻按容器宽度分档要用）",
);
ok(
  sideBlock.indexOf("padding-left") < 0 && sideBlock.indexOf("position: absolute") < 0,
  "该段里再无消息级预留（padding-left）+ 悬浮位（position:absolute）两条规则",
);
ok(
  DSH_CSS.indexOf(".dsh-msg.dsh-has-time") < 0 &&
    !/\.dsh-msg-side\s*[,{]/.test(DSH_CSS),
  "全文件再没有 .dsh-msg.dsh-has-time 与 .dsh-msg-side 选择器（四档容器查询里的分档一并删净）",
);
ok(
  DSH_CSS.replace(/\/\*[\s\S]*?\*\//g, "").indexOf(".dsh-msg-side") < 0 &&
    DSH_CSS.replace(/\/\*[\s\S]*?\*\//g, "").indexOf("dsh-has-time") < 0,
  "dsh.css 去掉注释后，.dsh-msg-side / dsh-has-time 一个引用都不剩（规则真的删净了）",
);
const segBlock = DSH_CSS.slice(
  DSH_CSS.indexOf("/* ── 逐项时刻（本次需求"),
  DSH_CSS.indexOf("/* 工具段皮肤盒"),
);
ok(segBlock.length > 0, "逐项时刻样式段仍在（这一层是本需求明确保留的）");
const segRule = (sel) => {
  const i = segBlock.indexOf(sel);
  if (i < 0) return "";
  const j = segBlock.indexOf("{", i);
  const k = segBlock.indexOf("}", j);
  return j < 0 || k < 0 ? "" : segBlock.slice(j + 1, k);
};
ok(
  /position:\s*relative/.test(segRule(".dsh-seg.dsh-seg-has-time {")) &&
    /padding-left:\s*var\(--dsh-seg-time-w/.test(segRule(".dsh-seg.dsh-seg-has-time {")),
  "逐项时刻栏照旧：宿主 relative + padding-left 让出 --dsh-seg-time-w",
);
ok(
  /position:\s*absolute/.test(segRule(".dsh-seg.dsh-seg-has-time > .dsh-seg-time {")) &&
    /width:\s*calc\(var\(--dsh-seg-time-w/.test(segRule(".dsh-seg.dsh-seg-has-time > .dsh-seg-time {")),
  "逐项时刻本体照旧：绝对定位在项内左侧、定宽不压强正文",
);
const segTiers = segBlock
  .split("@container (")
  .slice(1)
  .map((s) => Number((s.match(/--dsh-seg-time-w:\s*(\d+)px/) || [])[1]));
ok(
  segTiers.length >= 2 && segTiers.every((w) => w > 0) &&
    segTiers.every((w, i) => i === 0 || w <= segTiers[i - 1]),
  "逐项时刻档位随容器收窄单调不增（未受影响）：" + segTiers.map((w) => w + "px").join(" → "),
);

/* ==================== [5] 夹具与手册 ==================== */
console.log("\n[5] 夹具与手册：预览不再造消息级时刻栏；手册口径同步");
ok(
  stripJs(PREVIEW).indexOf("dsh-msg-side") < 0 &&
    stripJs(PREVIEW).indexOf("dsh-has-time") < 0,
  "test/_preview-seg-time.html 去掉注释后不再引用 .dsh-msg-side / .dsh-has-time（夹具与现口径一致）",
);
ok(
  /row\.className = "dsh-msg dsh-ai";/.test(PREVIEW) &&
    PREVIEW.indexOf("row.appendChild(side(") < 0,
  "预览夹具的消息类名与挂载点已同步（不再 append 消息级时刻）",
);
ok(
  /整条消息左侧另有一条「整条消息」的时刻/.test(MANUAL),
  "手册 guides/manual/dsh.md 仍留有「整条消息」时刻的原句（该句写明为已移除、供日后对本条需求）",
);
ok(
  MANUAL.indexOf("本次需求按用户口径已整体移除") < 0,
  "手册**不改**（本会话只动代码与回归；该处旧句留给后续手册轮次同步）",
);

/* ==================== 汇总 ==================== */
console.log("");
if (fails) {
  console.log("✗ " + fails + " / " + checks + " 项未通过  (smoke-msg-time-side)");
  process.exitCode = 1;
} else {
  console.log("✓ " + checks + " 项全部通过  (smoke-msg-time-side)");
}
