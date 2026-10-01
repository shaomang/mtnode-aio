"use strict";
/* 会话消息左侧悬浮时刻回归：时刻**不再单独占消息末尾一行**，改挂到每条消息左侧
 *   node test/smoke-msg-time-side.js
 *
 * 用户口径：对话区里每条消息的时刻放在消息**左侧**、悬浮显示，别在第二行再压一行时间。
 *
 * 被测真源（一个都不重写）：
 *   · renderer/app-assist.js —— dshMsgBlock 的时刻挂载（真在 vm 里跑出 DOM 判定）
 *   · renderer/css/dsh.css   —— .dsh-has-time / .dsh-msg-side 两档预留与悬浮点亮
 *
 * 覆盖：
 *   [1] 真渲染：AI 消息 → 时刻在左侧时刻栏（.dsh-msg-side），末尾时间行里没有时刻
 *   [2] 真渲染：没有时间戳的消息不挂时刻栏（老消息 / 系统行一字不动）
 *   [3] 源码口径：时刻从 tail 里摘掉、用户消息同一条路径、时刻取值格式化未改
 *   [4] 样式口径：左侧预留 + 绝对定位悬浮 + 悬浮点亮 + 档位走容器查询（不是窗口宽度）
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
console.log("\n[1] 真渲染：时刻挂在消息左侧时刻栏，末尾时间行里没有时刻");

/* 切片 = 被测函数本体（时刻格式化 → 档位/分段判定 → dshMsgBlock，只切真源码、不改一字） */
const from = ASSIST.indexOf("/* 消息末尾时间：精确到秒（非今天自动带日期） */");
const to = ASSIST.indexOf("/* ── 回滚入口：上一轮用户输入下方的「回滚」小按钮");
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
  rbLatestRid: () => "",
  rbHasMsgRound: () => false,
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

/* 定一个「今天的某秒」当时间戳：formatMsgTimeSec 今天只回 HH:MM:SS */
const AT = new Date(2026, 9, 1, 14, 3, 22).getTime();
const TIME_TXT = api.formatMsgTimeSec(AT);
const STAMP_TXT = api.formatMsgStamp(AT);
ok(/^\d{2}:\d{2}:\d{2}$/.test(TIME_TXT), "时刻取值仍是 formatMsgTimeSec（今天 = HH:MM:SS）：" + TIME_TXT);

const aiRow = api.dshMsgBlock(
  { role: "assistant", content: "你好", at: AT },
  "assist",
  0,
  {},
);
const sides = findAll(aiRow, "dsh-msg-side");
const tails = findAll(aiRow, "dsh-msg-tail");
const times = findAll(aiRow, "dsh-msg-time");
ok(sides.length === 1, "消息挂了一格 .dsh-msg-side（左侧时刻栏）");
ok(times.length === 1, "时刻只出现一次（不重复挂两处）");
ok(
  sides.length === 1 && times.length === 1 && sides[0] === times[0].parentNode,
  "那一刻时刻就挂在 .dsh-msg-side 里面",
);
ok(hasClass(aiRow, "dsh-has-time"), "消息带 .dsh-has-time（样式据此留左侧余量）");
ok(
  times[0] && times[0].textContent === TIME_TXT,
  "时刻文本 = formatMsgTimeSec（得到 " + (times[0] && times[0].textContent) + "）",
);
ok(
  times[0] && times[0].title === STAMP_TXT,
  "悬浮提示 = formatMsgStamp 完整时间戳（得到 " + (times[0] && times[0].title) + "）",
);
const tailTimes = tails.reduce((n, t) => n + findAll(t, "dsh-msg-time").length, 0);
ok(tailTimes === 0, "消息末尾的时间行里**不再有**时刻（第二行那行时间已摘掉）");
ok(
  aiRow.children.indexOf(sides[0]) >= 0 && aiRow.children.length >= 2,
  "时刻栏是消息的独立子元素（不挤在正文里）",
);
/* 末尾只剩动作按钮：AI 消息的「复制本条回复」还在尾行里 */
ok(
  tails.length >= 1 && findAll(tails[0], "dsh-msg-tail-copy").length === 1,
  "AI 回复末尾的小「复制本条回复」仍在 tail 里（只是不再与时刻同行）",
);

console.log("\n[2] 真渲染：没有时间戳的消息不挂时刻栏（老消息 / 系统行一字不动）");
const noTs = api.dshMsgBlock({ role: "assistant", content: "无时间戳" }, "assist", 1, {});
ok(findAll(noTs, "dsh-msg-side").length === 0, "没有 at / createdAt / ts 时不挂 .dsh-msg-side");
ok(findAll(noTs, "dsh-msg-time").length === 0, "也不出现 .dsh-msg-time");
ok(!hasClass(noTs, "dsh-has-time"), "不带 .dsh-has-time（不留左侧余量）");

/* ==================== [3] 源码口径 ==================== */
console.log("\n[3] 源码口径：时刻从 tail 摘出、挂在 row 上、只在有时刻时才挂");
ok(
  /const endTxt = formatMsgTimeSec\(m\.at \|\| m\.createdAt \|\| m\.ts\);/.test(ASSIST),
  "时刻仍取 m.at || m.createdAt || m.ts（取值口径未改）",
);
ok(
  /if \(endTxt\) \{[\s\S]{0,400}side\.className = "dsh-msg-side";/.test(ASSIST),
  "只有拿得到时刻时才建 .dsh-msg-side（没时刻不留空栏）",
);
ok(
  /row\.appendChild\(side\);[\s\S]{0,120}row\.classList\.add\("dsh-has-time"\);/.test(ASSIST),
  "时刻栏挂在 row 上、并给 row 打 .dsh-has-time",
);
ok(
  ASSIST.indexOf("row.appendChild(side);") <
    ASSIST.indexOf('tail.className = "dsh-msg-tail";'),
  "时刻栏在末尾时间行之前就位（渲染顺序：正文 → 时刻栏 → 末尾按钮行）",
);
ok(
  !/tail\.appendChild\(tEl\);/.test(ASSIST),
  "tail 里不再追加时刻元素（旧路径已摘干净）",
);
ok(
  /if \(rbRid \|\| m\.role === "assistant"\) \{/.test(ASSIST) &&
    !/if \(rbRid \|\| endTxt \|\| m\.role === "assistant"\) \{/.test(ASSIST),
  "末尾行的出现条件不再看 endTxt（时刻不占行后，没按钮就不挂空行）",
);
ok(
  (ASSIST.match(/const endTxt = formatMsgTimeSec\(/g) || []).length === 1,
  "dshMsgBlock 里时刻只算一次（用户 / AI 同一条路径）",
);

/* ==================== [4] 样式口径 ==================== */
console.log("\n[4] 样式口径：左侧预留两档 + 绝对定位悬浮 + 悬浮点亮");
const cssBlock = DSH_CSS.slice(
  DSH_CSS.indexOf("/* ── 消息左侧悬浮时刻（本次需求） ──"),
  DSH_CSS.indexOf("/* ── dsh 风格消息流(透明背景)"),
);
ok(cssBlock.length > 0, "dsh.css 里有「消息左侧悬浮时刻」样式段");
const ruleBody = (sel) => {
  const i = cssBlock.indexOf(sel);
  if (i < 0) return "";
  const j = cssBlock.indexOf("{", i);
  const k = cssBlock.indexOf("}", j);
  return j < 0 || k < 0 ? "" : cssBlock.slice(j + 1, k);
};
const sideSel = ".agent-list .dsh-msg-side,";
const padSel = ".agent-list .dsh-msg.dsh-has-time,";
const timeSel = ".agent-list .dsh-msg-side .dsh-msg-time,";
for (const [sel, name] of [
  [padSel, "常态预留"],
  [sideSel, "常态时刻栏"],
  [timeSel, "常态时刻字号"],
]) ok(!!ruleBody(sel), "dsh.css 有规则：" + name + "（" + sel + "）");
ok(
  /position:\s*relative/.test(ruleBody(padSel)) &&
    /padding-left:\s*(\d+)px/.test(ruleBody(padSel)),
  "带时刻的消息 position:relative + padding-left 预留（正文右侧让出时刻栏，不被压住）",
);
ok(
  /position:\s*absolute/.test(ruleBody(sideSel)) &&
    /left:\s*2px/.test(ruleBody(sideSel)) &&
    /width:\s*(\d+)px/.test(ruleBody(sideSel)),
  "时刻栏绝对定位在消息左内边距里（left:2px + 固定栏宽）",
);
ok(
  /white-space:\s*nowrap/.test(ruleBody(timeSel)) &&
    /font-family:\s*var\(--mono\)/.test(ruleBody(timeSel)) &&
    /font-variant-numeric:\s*tabular-nums/.test(ruleBody(timeSel)),
  "时刻一行不折 + 等宽 + 表格数字（字宽可量、栏宽留得住）",
);
ok(
  /\.dsh-msg:hover \.dsh-msg-side \.dsh-msg-time/.test(cssBlock) &&
    /opacity:\s*1/.test(ruleBody(".agent-list .dsh-msg:hover .dsh-msg-side .dsh-msg-time,")) &&
    /\.dsh-msg:focus-within \.dsh-msg-side \.dsh-msg-time/.test(cssBlock),
  "悬浮 / 聚焦时时刻点亮（:hover 与 :focus-within 同一条规则）",
);
/* 档位必须按**容器宽度**分（右栏会话在宽窗口里也可能只有 ~700px 宽：按窗口宽度
   分档会让窄栏拿到宽档、时刻压住正文 —— 首版就是栽在这上面） */
ok(
  /container-type:\s*inline-size/.test(cssBlock) &&
    /\.agent-body,\s*\n\.agent-conv,\s*\n\.ltg-conv \{\s*\n\s*container-type: inline-size/.test(cssBlock),
  "会话容器声明 container-type: inline-size（.agent-body / .agent-conv / .ltg-conv）",
);
const containerCount = (cssBlock.match(/@container \(/g) || []).length;
ok(containerCount >= 4, "档位走容器查询 @container（≥4 段，得到 " + containerCount + "）");
ok(!/@media \(max-width/.test(cssBlock), "档位不再走窗口宽度的 @media（窄栏会被误判成宽档）");
const tiers = cssBlock.split("@container (").slice(1).map((s) => {
  const w = s.match(/width:\s*(\d+)px/);
  const fs = s.match(/font-size:\s*([\d.]+)px/);
  return { width: w ? Number(w[1]) : null, font: fs ? Number(fs[1]) : null };
});
ok(
  tiers.every((t) => t.width > 0) &&
    tiers.every((t, i) => i === 0 || t.width <= tiers[i - 1].width),
  "各档栏宽随容器收窄单调不增：" + tiers.map((t) => t.width + "px").join(" → "),
);
ok(
  tiers.filter((t) => t.font).every((t) => t.font <= 10 && t.font >= 8),
  "各档字号都在 8–10px（不缩到看不清）：" + tiers.filter((t) => t.font).map((t) => t.font + "px").join(" → "),
);
ok(
  /\.agent-conv \.dsh-msg\.dsh-has-time/.test(cssBlock) &&
    /\.ltg-conv \.dsh-msg\.dsh-has-time/.test(cssBlock),
  "画布节点内会话（.agent-conv）与长任务会话（.ltg-conv）同口径",
);

/* ==================== 汇总 ==================== */
console.log("");
if (fails) {
  console.log("✗ " + fails + " / " + checks + " 项未通过  (smoke-msg-time-side)");
  process.exitCode = 1;
} else {
  console.log("✓ " + checks + " 项全部通过  (smoke-msg-time-side)");
}
