"use strict";
/* 会话正文「莫名频繁换行」回归冒烟测试 —— 纯 Node，只读源码文本 + 真跑打包的 marked（不依赖 Electron）
 *   node test/smoke-session-wrap.js
 * 保住的行为：会话消息正文（markdown 渲染产物）**不得**继承容器为流式纯文本设的
 * white-space: pre-wrap。marked 的输出里块与块之间真的带换行（`</p>\n<ul>\n<li>…`），
 * 一旦这些换行被当作空白渲染出来，段落之间、列表项之间就会各多出一个空行 ——
 * 表现就是用户说的「会话里偶尔频繁换行」。段内换行由 renderMarkdown 的
 * breaks:true 发成 <br>，不靠 pre-wrap。
 * 覆盖：
 *   [1] 根因复现：vendor marked 真的在块之间输出换行（所以 pre-wrap 一定会多撑行）
 *   [2] 修复点：.md 基础规则显式 white-space: normal（带注释说明为什么）
 *   [3] 全仓 CSS：没有任何针对 .md 元素自身的规则把空白保留又打开
 *   [4] 零误伤：流式未渲染正文的三套容器仍是 pre-wrap（换行照旧保留）
 *   [5] 会话 markdown 确实只经 .md 落进这些容器（渲染点齐全）
 *   [6] 段内换行不丢：renderMarkdown 仍带 breaks:true
 *   [7] 节点浏览视图：只有 yaml / plain 分支设内联 pre-wrap，md 分支不设 */
const fs = require("fs");
const path = require("path");

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
/* 读源码并统一换行：CSS 在 Windows 工作区里常是 CRLF，锚点串按 \n 写就好 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

/* ==================== [1] 根因复现 ==================== */
console.log("\n[1] vendor marked 的输出里块之间真的带换行");
const { marked } = require("../renderer/vendor/marked.min.js");
const mdOut = marked.parse(
  "第一段第一行\n第一段第二行\n\n- 列表项一\n- 列表项二\n\n最后一段",
  { gfm: true, breaks: true },
);
ok(mdOut.indexOf("</p>\n<ul>") >= 0, "段落与列表之间输出 `</p>\\n<ul>`（pre-wrap 下即空行）");
ok(mdOut.indexOf("</li>\n<li>") >= 0, "列表项之间输出 `</li>\\n<li>`（pre-wrap 下即多撑一行）");
ok(mdOut.indexOf("<br>") >= 0, "段内单个换行由 breaks:true 发成 <br>（不依赖 pre-wrap）");

/* ==================== [2] 修复点 ==================== */
console.log("\n[2] .md 基础规则把空白归位 normal");
const cssCanvas = read("renderer/css/canvas.css");
const mdRuleAt = cssCanvas.indexOf("\n.md {");
ok(mdRuleAt >= 0, "canvas.css 里能找到 .md 基础规则（Markdown 渲染一节）");
const mdRule = mdRuleAt >= 0 ? cssCanvas.slice(mdRuleAt, cssCanvas.indexOf("}", mdRuleAt) + 1) : "";
ok(/white-space:\s*normal/.test(mdRule), ".md 显式 white-space: normal（块间换行不再被渲染）");
ok(
  mdRule.indexOf("pre-wrap") >= 0 && mdRule.indexOf("breaks:true") >= 0,
  ".md 规则注释写清根因（容器 pre-wrap 被继承）与段内换行的真正来源（breaks:true）",
);

/* ==================== [3] 全仓 CSS 扫描 ==================== */
console.log("\n[3] 没有任何 .md 自身规则把空白保留又打开");
const cssDir = path.join(__dirname, "..", "renderer", "css");
const cssFiles = fs
  .readdirSync(cssDir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ["renderer/css/" + f, read("renderer/css/" + f)]);
ok(cssFiles.length >= 5, "扫到 renderer/css 全套样式表（" + cssFiles.length + " 份）");
function* rulesOf(src) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) yield { sel: m[1], body: m[2] };
}
let mdSelfRules = 0;
let mdPreWrapRules = [];
for (const [rel, src] of cssFiles) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const r of rulesOf(clean)) {
    const targetsMd = r.sel
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .some((s) => /(^|[\s>+~])\.md$/.test(s));
    if (!targetsMd) continue;
    mdSelfRules++;
    if (/white-space:\s*(pre|pre-wrap|pre-line)/.test(r.body)) mdPreWrapRules.push(rel);
  }
}
ok(mdSelfRules >= 6, "扫到多条针对 .md 自身的规则（含亮色主题与节点内压缩版：" + mdSelfRules + " 条）");
ok(mdPreWrapRules.length === 0, "全部 .md 自身规则里没有任何 white-space: pre*（回归清单：" + mdPreWrapRules.join(", ") + "）");

/* ==================== [4] 零误伤：流式纯文本容器 ==================== */
console.log("\n[4] 流式未渲染正文仍保留换行");
const cssDsh = read("renderer/css/dsh.css");
const containers = [
  [".dsh-msg-body", cssDsh],
  [".dsh-seg-say", cssDsh],
  [".chat-bubble", cssCanvas],
];
for (const [sel, src] of containers) {
  const at = src.indexOf("\n" + sel + " {");
  const body = at >= 0 ? src.slice(at, src.indexOf("}", at) + 1) : "";
  ok(/white-space:\s*pre-wrap/.test(body), sel + " 仍是 pre-wrap（纯文本 / 流式原文的换行照旧）");
}
/* 智能节点实时输出：元素同时挂了 .md（只为排版）与 dsh-out-live（装的是未渲染原文）
   —— 这条更-specific 的规则必须还在，否则本次修复会把节点实时输出的换行吃掉 */
ok(
  /\.n-out \.dsh-out-live\s*\{[^}]*white-space:\s*pre-wrap/.test(cssDsh),
  ".n-out .dsh-out-live 仍以 pre-wrap 压过 .md（节点实时原文不被归位 normal 误伤）",
);
ok(
  read("renderer/app-canvas.js").indexOf('className = "md dsh-out-live"') >= 0,
  "该元素确实带着 .md 类（正是需要被更-specific 规则保护的那一个）",
);

/* ==================== [5] 会话 markdown 落点 ==================== */
console.log("\n[5] 会话正文的 markdown 都装在 .md 里");
const assist = read("renderer/app-assist.js");
ok(
  (assist.match(/className = "md"/g) || []).length >= 2,
  "分段正文段（dsh-seg-say）与历史段渲染都各自套一层 .md",
);
ok(
  /<div class="md">' \+ renderMarkdown/.test(assist),
  "旧整条渲染（无分段轨迹时）也走 .md —— 本次修复对两条路径同时生效",
);
ok(
  read("renderer/app.js").indexOf('doc.className = "md-viewer-doc md"') >= 0,
  "应用内 Markdown 阅读器也带 .md 类（同款换行口径）",
);

/* ==================== [6] breaks:true ==================== */
console.log("\n[6] renderMarkdown 仍按聊天口径转义并换行");
const appjs = read("renderer/app.js");
const rmAt = appjs.indexOf("function renderMarkdown(text)");
const rmBody = rmAt >= 0 ? appjs.slice(rmAt, appjs.indexOf("\n}\n", rmAt)) : "";
ok(rmBody.indexOf("breaks: true") >= 0, "renderMarkdown 保持 breaks:true（否则用户单回车真的会消失）");
ok(rmBody.indexOf("escapeHtml(text)") >= 0, "renderMarkdown 先转义 HTML（渲染口径未被这次改动带偏）");

/* ==================== [7] 节点浏览视图 ==================== */
console.log("\n[7] 节点只读视图：只有 yaml / plain 内联 pre-wrap");
const nodeview = read("renderer/app-nodeview.js");
const mdBranch = nodeview.slice(
  nodeview.indexOf('if (lang === "md")'),
  nodeview.indexOf('body.className = "ntv-plain"'),
);
ok(mdBranch.length > 0, "切到节点视图的 md 分支源码");
ok(mdBranch.indexOf("whiteSpace") < 0, "md 分支不设内联 white-space（交给 CSS，不复活 pre-wrap）");
ok(
  nodeview.indexOf('pre.style.whiteSpace = "pre-wrap"') >= 0 &&
    nodeview.indexOf('body.style.whiteSpace = "pre-wrap"') >= 0,
  "yaml / plain 分支仍显式保留换行（它们装的是纯文本，不是 markdown）",
);

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-session-wrap)",
);
process.exit(fails ? 1 : 0);
