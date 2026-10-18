"use strict";
/* Markdown 编辑手感与序列化保真（renderer/app-mdedit.js + renderer/app-review.js 的
 * richToMarkdown / mdToRichHtml）：
 *   node test/smoke-md-edit-ux.js
 *
 * 为什么要起一只真窗口：这一层的行为全在真 DOM 上 —— 列表嵌套是 DOM 结构、Tab / 即时输入
 * 是选区与 KeyboardEvent、保真是「真 marked 渲染出的 HTML 再序列化回去」。
 * 极简 DOM 桩既解不了 marked 的 HTML，也测不出 `Range` / `getSelection` 的真实语义，
 * 所以这里按仓库既有的自验口径起一只隐藏窗口（tools/ 与 test/ 里已有先例），
 * 由它加载**真实的** marked.min.js + app-review.js + app-mdedit.js 跑两张表，本文件只做断言。
 *
 * 钉住的口径（用户本轮确认过的共识）：
 *   [1] 段落分隔不再被吃掉（原来 `parts.join("\n")` + breaks:true = 整篇并成一段）；
 *   [2] 折行 / 硬换行不再被折成行内空格，回写统一是「行尾两空格」的硬换行；
 *   [3] 行内代码里的连续空格原样保留（空白是内容本身）；
 *   [4] 嵌套列表回写仍是嵌套（子项缩进两格、项与项之间不留空行）；
 *   [5] 代码块里的空行 / 缩进 / 制表符一个字节都不动；
 *   [6] 块级结构（标题 / 引用 / 表格 / 分隔线 / 任务清单）稳定往返；
 *   [7] app-mdedit 的 Tab：富文本档只在光标处插 4 个空格（选中多行 → 每行行首各插一次），
 *       不改列表层级、不新建块；Shift+Tab 在富文本档不接管；代码块里 Tab 同样只管插空格、
 *       不把光标踢出编辑区；改完 DOM 必须自己派发一次 input（宿主的脏标记 / 实时保存靠它），
 *       否则宿主按旧正文重渲染就把缩进吃了（早先的「Tab 增加序号后自动回滚」）；
 *   [9] 即时成块（空块里敲 `- ` / `1. ` / `# ` / `> ` / `- [ ] ` 自动变块）已按用户口径整体下线：
 *       编辑器不再替用户改 Markdown 结构，敲进去什么就是什么。
 *
 * 注：文本节点板身正文框与文本处理节点提示词框的键位归一为 bindSource（Tab = 4 空格），
 *   层级序号那套自定义键位已下线（`3.1. ` 不是合法的 Markdown 列表标记）；
 *   展示层的 1. → 1.1. → 1.1.1. 改由 CSS 计数器负责，回归在 test/smoke-md-outline.js。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

const HTML = read("renderer/index.html");
const MDEDIT = read("renderer/app-mdedit.js");
const REVIEW = read("renderer/app-review.js");

/* ═══════════ [1] 静态接线：模块、加载顺序、调用点 ═══════════ */
console.log("\n[1] 接线：app-mdedit.js 就位，四处编辑面都取它");
{
  ok(fs.existsSync(path.join(ROOT, "renderer/app-mdedit.js")), "renderer/app-mdedit.js 存在");
  const atReview = HTML.indexOf('src="app-review.js"');
  const atMd = HTML.indexOf('src="app-mdedit.js"');
  const atText = HTML.indexOf('src="app-textedit.js"');
  ok(atReview >= 0 && atMd > atReview, "index.html：app-mdedit.js 排在 app-review.js 之后（mdToRichHtml 在调用期取）");
  ok(atMd < atText && atText > 0, "index.html：app-mdedit.js 排在 app-textedit.js 之前");
  ok(atText > 0 && HTML.indexOf('src="app-canvas.js"') > 0, "index.html：四处编辑面的脚本位都在（加载顺序不影响它们：一律调用期取 MTMdEdit）");
  ok(/window\.MTMdEdit = api/.test(MDEDIT), "app-mdedit.js 出口 window.MTMdEdit");
  /* 四个编辑面各自接线（缺一处就等于那处没修） */
  ok(/MTMdEdit\.bindRich\(ed\)/.test(read("renderer/app-textedit.js")), "文本节点 ✎ 编辑器：富文本档接线 bindRich");
  ok(/MTMdEdit\.bindSource\(ta\)/.test(read("renderer/app-textedit.js")), "文本节点 ✎ 编辑器：源码档接线 bindSource");
  ok(/MTMdEdit\.bindRich\(ed\)/.test(REVIEW), "✎ AI 审阅窗：富文本档接线 bindRich");
  ok(/MTMdEdit\.bindSource\(ta\)/.test(REVIEW), "✎ AI 审阅窗：源码档接线 bindSource");
  const appjs = read("renderer/app.js");
  ok(/MTMdEdit\.bindRich\(ed\)/.test(appjs), "内置 Markdown 阅读器编辑态：富文本档接线 bindRich");
  ok(/MTMdEdit\.bindSource\(ta\)/.test(appjs), "内置 Markdown 阅读器编辑态：源码档接线 bindSource");
  ok(
    /MTMdEdit\.bindSource\(ta\)/.test(read("renderer/app-canvas.js")),
    "画布节点板身正文 textarea：接线 bindSource（Tab = 4 空格；层级序号已下线）",
  );
  ok(
    !/MTMdEdit\.bindOutline/.test(MDEDIT + appjs + REVIEW + read("renderer/app-canvas.js")),
    "层级序号那套入口（bindOutline）已从模块与全部接线点下线",
  );
  /* 本轮下线的三样（都不许回潮） */
  ok(!/function (indentItem|outdentItem|listItemsAt|normalizeLists)\(/.test(MDEDIT), "列表缩进 / 反缩进那套工具函数已从模块删除");
  ok(!/LEAD_RE|convertBlockAtCaret|onRichInput/.test(MDEDIT), "即时成块（`- ` / `1. ` / `# ` / `> ` / `- [ ] `）的解析与改写已删除");
  ok(
    /function fireInput\(el\)/.test(MDEDIT) && (MDEDIT.match(/fireInput\(/g) || []).length >= 3,
    "改完 DOM 一律自己派发 input（宿主的脏标记 / 实时保存才看得到，Tab 才不会回滚）",
  );
  /* 保真口径的源码锚点（真跑在 [3]） */
  ok(/parts\.join\("\\n\\n"\)|out\.push\(""\)/.test(REVIEW), "richToMarkdown 有块间隔（段落之间补空行）");
  ok(/replace\(\/ \*\\n \*\/g, "  \\n"\)/.test(REVIEW), "行内换行 → 行尾两空格硬换行");
  ok(/if \(tag === "code"\) return "`" \+ node\.textContent \+ "`";/.test(REVIEW), "行内代码原样取 textContent");
  ok(/function walkMdList\(/.test(REVIEW), "列表按层级走 walkMdList");
  /* 本轮修的三处序列化 / 回写隐患，钉在源码上（真跑在 [3][5]） */
  ok(
    /const step = unordered \? "  " : "    ";/.test(REVIEW),
    "子表缩进按父项正文列（无序 2 格 / 有序 4 格）—— 有序列表缩 2 格会被 CommonMark 判成续行、保存一次就掉层",
  );
  ok(
    /getAttribute\("start"\)/.test(REVIEW),
    "列表编号取 <ol start> 的真实起始号（否则从 3 开始的列表打回 1.）",
  );
  const TE = read("renderer/app-textedit.js");
  ok(
    /function teLiftBlocksOutOfP\(/.test(TE) && /teLiftBlocksOutOfP\(ed\)/.test(TE),
    "teCommit 把被塞进 <p> 的块（ul / ol / pre / table / hr / blockquote / h1-h3）提出来",
  );
  ok(
    /function teRefreshBoardBrowse\(/.test(TE) && /if \(changed\) teRefreshBoardBrowse\(node\);/.test(TE),
    "编辑器写回正文后重建画布节点的浏览态预览（否则关窗后画布还是改之前那一版）",
  );
  /* 本轮用户口径：工具栏下线「水平线 / 任务清单」两颗插入按钮（三处编辑面一起） */
  const APPS = read("renderer/app.js");
  ok(!/mk\("hr"/.test(TE + REVIEW + APPS), "三处编辑器工具栏都不再有「水平线」按钮");
  ok(!/mk\("task"/.test(TE + REVIEW + APPS), "三处编辑器工具栏都不再有「任务清单」勾选框按钮");
  /* 光标落点：点工具栏 = 不许夺焦；没挪 DOM = 不许重设选区；偏移尺子给 <br> 与块尾留位 */
  ok(
    /b\.addEventListener\("mousedown", \(ev\) => ev\.preventDefault\(\)\);/.test(REVIEW),
    "审阅工具栏的按钮 mousedown 一律 preventDefault（按下不夺焦，插入才落对光标）",
  );
  ok(
    /const moved = teLiftBlocksOutOfP\(ed\);[\s\S]{0,80}if \(moved\) teRestoreFocusSnapshot\(keep\);/.test(TE),
    "teCommit 只在真挪过块时才还原选区（否则每个键 / 每拍轮询都把光标按偏移重算一遍）",
  );
  ok(
    /const ATOM_TAG = \/\^\(BR\|IMG\|HR\)\$\//.test(MDEDIT) && /const BLOCK_TAG =/.test(MDEDIT),
    "文本偏移尺子：<br>/<img>/<hr> 与块级元素各占一位（回车后的新行不会与上一行末尾撞同一个偏移）",
  );
  ok(
    /function richCaretSame\(el, snap\)/.test(MDEDIT) && /!richCaretSame\(el, snap\)/.test(MDEDIT),
    "选区已经等价于快照就不重设（不打断输入法、不把刚点下的落点拽走）",
  );
}

/* ═══════════ [2] 真窗口探针（真 marked + 真 app-review.js + 真 app-mdedit.js） ═══════════ */
console.log("\n[2] 真窗口：加载真实模块跑保真表与编辑手感表");
const exe = (() => {
  const cands = [
    path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    path.join(ROOT, "node_modules", "electron", "dist", "electron"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "";
})();

if (!exe) {
  console.log("  SKIP  Electron 运行时不可用：本机没装 node_modules/electron/dist");
  console.log("        （保真与编辑手感只有真 DOM 能测，这里如实跳过，不假装通过）");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-mdedit-"));
  const outJson = path.join(tmp, "out.json");
  /* 调试用：设 MTNODE_MDEDIT_PROBE_KEEP=1 时保留现场（打印临时目录），便于人工复跑 */
  const keep = String(process.env.MTNODE_MDEDIT_PROBE_KEEP || "") === "1";
  if (keep) console.log("  现场保留在 " + tmp);
  const fileUrl = (p) => "file:///" + p.split(path.sep).join("/");
  const page = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script src="${fileUrl(path.join(ROOT, "renderer/vendor/marked.min.js"))}"><\/script>
<script>
  /* app-review.js 加载期要用到的两个全局（与 index.html 的真实环境同形） */
  window.I18n = { t: function (s) { return s; } };
  window.MTNodeFactLib = null;
  window.MTMathRender = null;
<\/script>
<script src="${fileUrl(path.join(ROOT, "renderer/app-review.js"))}"><\/script>
<script src="${fileUrl(path.join(ROOT, "renderer/app-mdedit.js"))}"><\/script>
<script>
window.__probe = function () {
  var out = { roundTrip: {}, edit: {}, err: "" };
  try {
    /* ── 先做一只「干净容器」里的源码档测试：此时页面里只有它一个可编辑元素，
       选区不会与后面的富文本用例互相干扰（这也是复现真实使用的必要条件）。 ── */
    var iso = document.createElement("div");
    document.body.appendChild(iso);
    /* 用 fromCharCode 拼正文：避免在多层模板字符串里让 \n 变成两个字面字符（踩过这个坑） */
    var NL = String.fromCharCode(10);
    var SP = String.fromCharCode(32);
    var isoText = "-" + SP + "甲" + NL + SP + SP + "-" + SP + "甲一" + NL;
    var isoTa = document.createElement("textarea");
    iso.appendChild(isoTa);
    isoTa.value = isoText;
    isoTa.focus();
    isoTa.setSelectionRange(isoText.indexOf("甲一") - 2, isoText.indexOf("甲一") - 2);
    var isoSel = isoTa.selectionStart + "," + isoTa.selectionEnd;
    var isoTab = MTMdEdit.tabSource(isoTa);
    var isoAfterTab = isoTa.value;
    /* 光标落到第二行（刚才缩进过的那一行）再反缩进 */
    isoTa.setSelectionRange(isoAfterTab.indexOf("甲一"), isoAfterTab.indexOf("甲一"));
    var isoReadBack = isoTa.selectionStart + "," + isoTa.selectionEnd;
    var isoShift = MTMdEdit.shiftTabSource(isoTa);
    out.edit.srcIso = {
      selBefore: isoSel,
      tabbed: isoTab,
      afterTab: isoAfterTab,
      selSetShouldBe2: isoReadBack,
      shifted: isoShift,
      afterShift: isoTa.value,
      active: document.activeElement === isoTa
    };
    iso.parentNode.removeChild(iso);
    /* ── 保真表：真 marked 渲染 → richToMarkdown 回写 ── */
    var samples = {
      "段落分隔": "第一段\\n\\n第二段\\n",
      "折行(单换行)": "第一行\\n第二行\\n",
      "硬换行(两空格)": "第一行  \\n第二行\\n",
      "行内代码空格": "a \\x60x   y\\x60 b\\n",
      "嵌套列表": "- 甲\\n  - 甲一\\n  - 甲二\\n- 乙\\n",
      "有序列表": "1. 甲\\n2. 乙\\n3. 丙\\n",
      /* 有序列表套有序列表：子表缩进必须够到父项正文列（「1. 」= 3 列，取 4 空格）；
         早先写 2 空格会被 CommonMark 判成同级，保存一次层级就没了。 */
      "嵌套有序列表": "1. 第一项\\n2. 第二项\\n    1. 子项甲\\n    2. 子项乙\\n",
      /* 从 3 开始的列表：回写要保住起始号（靠 <ol start> → 真编号），不能打回 1. */
      "起始号列表": "3. 甲\\n4. 乙\\n5. 丙\\n",
      /* 空的待办项：正文里是一行「- [ ]」，回写不能把它吃掉 */
      "待办空项": "- [ ] 甲\\n- [ ]\\n",
      "任务清单": "- [x] 甲\\n- [ ] 乙\\n",
      "段后接列表": "说明：\\n\\n- 甲\\n- 乙\\n",
      "列表后接段落": "- 甲\\n- 乙\\n\\n收尾说明\\n",
      "标题与段落": "# 标题\\n\\n正文\\n\\n## 二级\\n\\n又一段\\n",
      "代码块": "\\x60\\x60\\x60\\nline1\\n\\n\\nline3\\n\\x60\\x60\\x60\\n",
      "代码块制表符": "\\x60\\x60\\x60\\na   b\\n\\u0009c\\n\\x60\\x60\\x60\\n",
      "表格": "| a | b |\\n| --- | --- |\\n| 1 | 2 |\\n",
      "分隔线": "A\\n\\n---\\n\\nB\\n",
      "引用块": "> 第一行\\n> 第二行\\n"
    };
    for (var k in samples) {
      var raw = samples[k];
      var box = document.createElement("div");
      box.innerHTML = mdToRichHtml(raw);
      out.roundTrip[k] = { raw: raw, back: richToMarkdown(box) };
    }

    /* ── 工具栏产物 → 回写（本轮修的三个现场都发生在这里，DOM 手工搭，不经过 marked）── */
    var ser = function (html) {
      var box = document.createElement("div");
      box.innerHTML = html;
      return richToMarkdown(box);
    };
    /* 同一个 DOM 连回写两次 + 数勾选框：序列化函数不许改 DOM（改了就重复一行、多一颗框） */
    var serTwice = function (html) {
      var box = document.createElement("div");
      box.innerHTML = html;
      var before = box.querySelectorAll("input[type=checkbox]").length;
      var a = richToMarkdown(box);
      var b = richToMarkdown(box);
      return { first: a, second: b, boxesBefore: before, boxesAfter: box.querySelectorAll("input[type=checkbox]").length };
    };
    out.serialize = {
      /* 水平线被塞进 p 里（工具栏早先就是 insertAtCaret("<hr>")）：
         必须按水平线把段落切开、输出 ---，而不是把整段当行内文本把 hr 丢掉 */
      hrInPara: ser("<p>甲<hr>乙</p>"),
      /* 水平线作为独立块（前后各留一个空段，就是工具栏现在的产物） */
      hrBlock: ser("<p>甲</p><p><br></p><hr><p><br></p><p>乙</p>"),
      /* 显示公式：一整段 $$ 不能有内层空行（早先推成三 part 被插空行，保存就废） */
      mathDisplay: ser(
        '<p><span class="rv-math" data-rv-tex="a=b" data-rv-display="1" data-rv-delim="$$">a=b</span></p>',
      ),
      /* 待办清单：真复选框 + 行内勾选框 → 行首 - [ ] / - [x] */
      taskList: ser('<ul data-task="1"><li><input type="checkbox">甲</li></ul>'),
      taskListDone: ser('<ul data-task="1"><li><input type="checkbox" checked>甲</li></ul>'),
      /* 工具栏刚点下去的待办项是空的（只有一个换行占位）：这一行也要落进正文 */
      taskEmpty: ser('<ul data-task="1"><li><input type="checkbox"><br></li></ul>'),
      /* 松散列表里的待办项：正文里「无序列表 + 空行 + 待办」会被 marked 并成一个 <ul>，
         项内容包在 <p> 里。行首 [ ] 由这里补，且序列化**不许往 DOM 里插第二颗勾选框**
         （早先插了：活 NodeList 回退指针把同一项走了两遍 → 正文重复一行、界面两颗勾选框） */
      taskLoose: ser('<ul><li><input type="checkbox">甲</li><li><p><input type="checkbox" checked>乙</p></li></ul>'),
      taskLooseTwice: serTwice('<ul><li><p><input type="checkbox">甲</p></li></ul>'),
      /* 显示公式紧跟在引用 / 段落后面：块前必须空一行，否则 CommonMark 的懒续行
         会把「$$」吸进引用块，读回来就没有公式了 */
      mathAfterQuote: ser(
        '<blockquote>甲</blockquote><p><span class="rv-math" data-rv-tex="b" data-rv-display="1" data-rv-delim="$$">b</span></p>',
      ),
      /* 起始号：源码 3. 开头，渲染出的 <ol start="3"> 要带上计数器初值 */
      olStartHtml: mdToRichHtml("3. 甲\\n4. 乙\\n"),
      olPlainHtml: mdToRichHtml("1. 甲\\n2. 乙\\n")
    };

    /* ── 编辑手感表：真 Range / getSelection / KeyboardEvent ── */
    var mkRich = function (html) {
      var ed = document.createElement("div");
      ed.setAttribute("contenteditable", "true");
      ed.contentEditable = "true";
      if (html) ed.innerHTML = html;
      document.body.appendChild(ed);
      /* 与真实编辑面同一条接线：Tab / 即时输入 / 粘贴都挂在 bindRich 上 */
      MTMdEdit.bindRich(ed);
      return ed;
    };
    var putCaret = function (node, off) {
      var r = document.createRange();
      r.setStart(node, off || 0);
      r.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    var textOfFirstLi = function (ed) {
      var li = ed.querySelector("li");
      return li ? li.textContent : "";
    };
    var nestDepth = function (ed, li) {
      var n = 0;
      var p = li.parentNode;
      while (p && p !== ed) {
        if (p.tagName && p.tagName.toLowerCase() === "li") n++;
        p = p.parentNode;
      }
      return n;
    };

    var selInEd = function (ed) {
      var s = window.getSelection();
      if (!s || !s.rangeCount) return false;
      return ed.contains(s.getRangeAt(0).startContainer);
    };

    /* [7a] 折叠光标在段落里按 Tab → 光标处插 4 个空格：不新建块、不改结构、光标留在原编辑区，
       并且自己派发一次 input（宿主靠它记脏 / 实时保存，早先不派发就是「Tab 后自动回滚」的根因）。 */
    var ed1 = mkRich("<p>甲</p>");
    var t1 = ed1.querySelector("p").firstChild;
    putCaret(t1, 1);
    var inputs1 = 0;
    ed1.addEventListener("input", function () { inputs1++; });
    var consumed = MTMdEdit.tabRich(ed1);
    out.edit.tabCaret = {
      consumed: consumed,
      text: ed1.querySelector("p").textContent,
      blocks: ed1.children.length,
      caretIn: selInEd(ed1),
      inputs: inputs1,
      md: richToMarkdown(ed1)
    };

    /* [7b] 选中两段按 Tab → 每段行首各插 4 个空格（与源码档同一口径，不改列表层级） */
    var ed2 = mkRich("<p>甲一</p><p>乙二</p>");
    var ps2 = ed2.querySelectorAll("p");
    var r2 = document.createRange();
    r2.setStart(ps2[0].firstChild, 0);
    r2.setEnd(ps2[1].firstChild, 2);
    var s2 = window.getSelection();
    s2.removeAllRanges();
    s2.addRange(r2);
    var consumed2 = MTMdEdit.tabRich(ed2);
    var ps2b = ed2.querySelectorAll("p");
    out.edit.tabMulti = {
      consumed: consumed2,
      bothIndented: /^ {4}甲一$/.test(ps2b[0].textContent) && /^ {4}乙二$/.test(ps2b[1].textContent),
      md: richToMarkdown(ed2)
    };

    /* [7c] 富文本档 Shift+Tab：不做任何 Markdown 处理（交回浏览器），正文结构一个字不动 */
    var ed3 = mkRich("<ul><li>甲<ul><li>甲一</li></ul></li></ul>");
    var inner3 = ed3.querySelector("ul ul li");
    putCaret(inner3.firstChild, 1);
    var before3 = richToMarkdown(ed3);
    var consumed3 = MTMdEdit.shiftTabRich(ed3);
    out.edit.shiftTabRich = {
      consumed: consumed3,
      unchanged: richToMarkdown(ed3) === before3
    };

    /* [7d] 代码块里按 Tab：一样插 4 个空格（早先这里放行跳焦点，用户体感就是「按 Tab 焦点跑了」） */
    var ed5 = mkRich("<pre><code>code</code></pre>");
    putCaret(ed5.querySelector("code").firstChild, 2);
    out.edit.codeTab = {
      consumed: MTMdEdit.tabRich(ed5),
      text: ed5.querySelector("code").textContent
    };

    /* [9] 即时成块已下线：模块不再导出改写入口，敲完标记派发 input 也不会被改成块 */
    var paraStays = (function () {
      var ed = mkRich("<p>- </p>");
      var p9 = ed.querySelector("p");
      putCaret(p9.firstChild, 2);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      var el = ed.firstElementChild;
      return !!(el && el.tagName && el.tagName.toLowerCase() === "p");
    })();
    out.edit.noAutoBlock = {
      hasOnRichInput: typeof MTMdEdit.onRichInput === "function",
      hasConvert: typeof MTMdEdit.convertBlockAtCaret === "function",
      paraStaysPara: paraStays
    };

    /* [8] 源码档 textarea：Tab 把当前行缩进 4 空格、Shift+Tab 退一档。
       （textarea 的正文换行用 String.fromCharCode 拼：多层模板字符串里的 \n 会变成
       字面字符，这一版踩过；选区用 selectionStart/End 直接读写。） */
    var NLp = String.fromCharCode(10);
    var SPp = String.fromCharCode(32);
    var ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.value = "-" + SPp + "甲" + NLp + SPp + SPp + "-" + SPp + "甲一" + NLp;
    ta.focus();
    ta.selectionStart = ta.value.indexOf("甲一");
    ta.selectionEnd = ta.selectionStart;
    var selBefore = ta.selectionStart + "," + ta.selectionEnd;
    var tabbed = MTMdEdit.tabSource(ta);
    var afterTab = ta.value;
    var selAfter = ta.selectionStart + "," + ta.selectionEnd;
    /* 光标落到第二行（刚才缩进过的那一行）再反缩进 */
    ta.setSelectionRange(afterTab.indexOf("甲一"), afterTab.indexOf("甲一"));
    var shifted = MTMdEdit.shiftTabSource(ta);
    out.edit.srcTab = {
      tabbed: tabbed,
      selBefore: selBefore,
      afterTab: afterTab,
      selAfter: selAfter,
      shifted: shifted,
      afterShift: ta.value
    };
    var ta2 = document.createElement("textarea");
    document.body.appendChild(ta2);
    ta2.value = "没有缩进的一行";
    ta2.focus();
    ta2.selectionStart = 2;
    ta2.selectionEnd = 2;
    var selNoIndent = ta2.selectionStart + "," + ta2.selectionEnd;
    out.edit.srcShiftNoIndent = MTMdEdit.shiftTabSource(ta2);
    out.edit.srcNoIndentSel = selNoIndent;
  } catch (e) {
    out.err = String((e && e.stack) || (e && e.message) || e);
  }
  return out;
};
<\/script>
</body></html>`;

  const pagePath = path.join(tmp, "probe.html");
  fs.writeFileSync(pagePath, page, "utf8");
  const hostPath = path.join(tmp, "host.js");
  fs.writeFileSync(
    hostPath,
    `"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
app.disableHardwareAcceleration();
app.setPath("userData", path.join(${JSON.stringify(tmp)}, "ud"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  let res = { err: "no result" };
  try {
    await win.loadFile(path.join(__dirname, "probe.html"));
    res = await win.webContents.executeJavaScript("window.__probe && window.__probe()");
  } catch (e) {
    res = { err: String((e && e.stack) || e) };
  }
  fs.writeFileSync(${JSON.stringify(outJson)}, JSON.stringify(res, null, 1), "utf8");
  app.exit(0);
});
`,
    "utf8",
  );

  const run = spawnSync(exe, [hostPath, "--no-sandbox"], {
    cwd: tmp,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  let probe = null;
  try {
    probe = JSON.parse(fs.readFileSync(outJson, "utf8"));
  } catch (e) {
    probe = null;
  }
  if (!probe) {
    const why = [
      "status=" + (run && run.status),
      "signal=" + (run && run.signal),
      "error=" + ((run && run.error && run.error.message) || "-"),
      "stderr=" + String((run && run.stderr) || "").slice(-300),
    ].join(" · ");
    ok(false, "真窗口探针没有产出结果（" + why + "）");
  } else {
    if (probe.err) ok(false, "探针执行出错：" + probe.err);
    const rt = probe.roundTrip || {};
    const back = (k) => (rt[k] ? String(rt[k].back) : "");
    const raw = (k) => (rt[k] ? String(rt[k].raw) : "");

    /* ═══ [3] 保真 ═══ */
    console.log("\n[3] 序列化保真（真 marked 渲染 → 回写）");
    ok(back("段落分隔") === raw("段落分隔"), "段落分隔保住（两段之间仍是空行）");
    ok(
      /^第一行 {2}\n第二行\n$/.test(back("折行(单换行)")),
      "折行不再被折成行内空格（写成两空格硬换行）",
    );
    ok(back("硬换行(两空格)") === raw("硬换行(两空格)"), "硬换行往返一致");
    ok(back("行内代码空格") === raw("行内代码空格"), "行内代码里的连续空格原样保留");
    ok(back("嵌套列表") === raw("嵌套列表"), "嵌套列表仍是嵌套（子项缩进两格、不留空行）");
    ok(
      back("嵌套有序列表") === raw("嵌套有序列表"),
      "有序列表套有序列表：`1.` / `2.` 真编号 + 子项缩进 4 空格，往返不掉层 —— 拿到 " + JSON.stringify(back("嵌套有序列表")),
    );
    ok(
      back("起始号列表") === raw("起始号列表"),
      "从 3 开始的列表保住起始号（3. 4. 5.）—— 拿到 " + JSON.stringify(back("起始号列表")),
    );
    ok(
      back("待办空项") === raw("待办空项"),
      "空的待办项 `- [ ]` 不被吃掉 —— 拿到 " + JSON.stringify(back("待办空项")),
    );
    ok(back("段后接列表") === raw("段后接列表"), "段落 → 列表：段落分隔保住");
    ok(back("列表后接段落") === raw("列表后接段落"), "列表 → 段落：两边都在");
    ok(back("标题与段落") === raw("标题与段落"), "标题 / 段落混排往返一致");
    ok(back("代码块") === raw("代码块"), "代码块里的空行一个不少");
    ok(back("代码块制表符") === raw("代码块制表符"), "代码块里的缩进与制表符原样");
    ok(back("表格") === raw("表格"), "表格往返一致");
    ok(back("分隔线") === raw("分隔线"), "分隔线往返一致");
    ok(/^1\. 甲\n2\. 乙\n3\. 丙\n$/.test(back("有序列表")), "有序列表：按渲染出的序号真编号（1. 2. 3.），起始号由 start 决定");
    ok(back("任务清单") === raw("任务清单"), "任务清单：勾选态 [x] / [ ] 保住");
    ok(/^> 第一行 {2}\n> 第二行\n$/.test(back("引用块")), "引用块两行都在（行内换行保真）");

    /* ═══ [4] 编辑手感 ═══ */
    console.log("\n[4] 编辑手感（Tab 插 4 空格 / 多行缩进 / 源码档 / 即时成块已下线）");
    const ed = probe.edit || {};
    ok(ed.tabCaret && ed.tabCaret.consumed === true, "富文本档 Tab 被接管（光标不跳出编辑区）");
    ok(
      ed.tabCaret && ed.tabCaret.text === "甲    ",
      "折叠光标按 Tab：光标处插 4 个空格 —— 拿到 " + JSON.stringify(ed.tabCaret && ed.tabCaret.text),
    );
    ok(
      ed.tabCaret && ed.tabCaret.blocks === 1 && ed.tabCaret.caretIn === true,
      "Tab 不新建块、不改结构，光标仍留在原编辑区里",
    );
    ok(
      ed.tabCaret && ed.tabCaret.inputs === 1,
      "Tab 改完自己派发一次 input（宿主的脏标记 / 实时保存才看得到）—— 实测 " +
        (ed.tabCaret && ed.tabCaret.inputs) +
        " 次",
    );
    ok(ed.tabMulti && ed.tabMulti.consumed === true, "选中多行按 Tab 被接管");
    ok(
      ed.tabMulti && ed.tabMulti.bothIndented === true,
      "选中两段 → 每段行首各插 4 个空格（不再改列表层级、不再接管序号）",
    );
    ok(
      ed.tabMulti && /^ {4}甲一$/m.test(String(ed.tabMulti.md)),
      "回写 Markdown 是行首 4 空格（正文原样，编辑器不替用户改结构）—— 拿到 " +
        JSON.stringify(ed.tabMulti && ed.tabMulti.md),
    );
    ok(ed.shiftTabRich && ed.shiftTabRich.consumed === false, "富文本档 Shift+Tab 不接管（不做 Markdown 处理）");
    ok(ed.shiftTabRich && ed.shiftTabRich.unchanged === true, "Shift+Tab 不动正文结构");
    ok(
      ed.codeTab && ed.codeTab.consumed === true && /^co {4}de$/.test(String(ed.codeTab.text)),
      "代码块里 Tab 同样只管插 4 个空格、不跳焦点 —— 拿到 " + JSON.stringify(ed.codeTab && ed.codeTab.text),
    );
    ok(
      ed.noAutoBlock && ed.noAutoBlock.hasOnRichInput === false && ed.noAutoBlock.hasConvert === false,
      "即时成块（`- ` / `# ` / `> `）的改写入口已整体下线",
    );
    ok(
      ed.noAutoBlock && ed.noAutoBlock.paraStaysPara === true,
      "敲 `- ` 之后段落仍是段落（浏览器插字，编辑器不再改写结构）",
    );
    const iso = (probe.edit || {}).srcIso || {};
    ok(iso.tabbed === true && iso.afterTab === "- 甲\n      - 甲一\n", "源码档 Tab 把当前行缩进 4 个空格");
    ok(iso.shifted === true && iso.afterShift === "- 甲\n  - 甲一\n", "源码档 Shift+Tab 把上一档的 4 个空格退掉");
    ok(ed.srcShiftNoIndent === false, "源码档 Shift+Tab 在本行没有缩进时不接管（放行跳焦点）");

    /* ═══ [5] 工具栏产物回写（水平线 / 显示公式 / 待办清单 / 起始号） ═══ */
    console.log("\n[5] 工具栏插入的块 → 保存下来的 Markdown（本轮用户报的三个现场）");
    const sr = probe.serialize || {};
    const s = (k) => String(sr[k] == null ? "" : sr[k]);
    ok(/^甲\n\n---\n\n乙$/.test(s("hrInPara").trim()), "水平线夹在段落里：按水平线切开、输出 `---`（不再保存后消失）—— 拿到 " + JSON.stringify(s("hrInPara")));
    ok(/---/.test(s("hrBlock")), "水平线作为独立块：`---` 真的落进源码");
    ok(/^\$\$\na=b\n\$\$$/.test(s("mathDisplay").trim()), "显示公式保存成一整段 `$$…$$`（内层不允许空行）—— 拿到 " + JSON.stringify(s("mathDisplay")));
    ok(/^- \[ \] 甲$/m.test(s("taskList")), "待办清单：`- [ ] 甲`（不是普通圆点列表）");
    ok(/^- \[x\] 甲$/m.test(s("taskListDone")), "待办清单勾选态：`- [x] 甲`");
    ok(/^- \[ \]$/m.test(s("taskEmpty")), "刚点下去的空待办项也落成 `- [ ]`（不再整行消失）—— 拿到 " + JSON.stringify(s("taskEmpty")));
    ok(
      /^- \[ \] 甲\n- \[x\] 乙$/m.test(s("taskLoose").trim()),
      "松散列表（项内容包在 <p> 里）里的待办项也出行首 [ ] / [x]，不重复、不丢勾选态 —— 拿到 " + JSON.stringify(s("taskLoose")),
    );
    const tw = sr.taskLooseTwice || {};    ok(
      String(tw.first || "").trim() === "- [ ] 甲" && tw.second === tw.first,
      "同一份 DOM 连回写两次结果一样（序列化不改 DOM）—— 拿到 " + JSON.stringify(tw.first),
    );
    ok(
      tw.boxesBefore === 1 && tw.boxesAfter === 1,
      "回写不再往项里插第二颗勾选框（界面上不会出现两颗框）—— 前后 " + tw.boxesBefore + " → " + tw.boxesAfter,
    );
    ok(
      /^> 甲\n\n\$\$\nb\n\$\$$/m.test(s("mathAfterQuote").trim()),
      "显示公式紧跟在引用后面时，块前留一个空行（否则被引用块懒续行吃掉）—— 拿到 " + JSON.stringify(s("mathAfterQuote")),
    );
    ok(/<ol start="3"/.test(s("olStartHtml")), "起始号 3：marked 直接出 `<ol start=\"3\">`，编号交给浏览器原生渲染");
    ok(!/counter-reset|style=/.test(s("olStartHtml")), "起始号不再写内联计数器初值（CSS 计数器已下线）");
    ok(!/style=/.test(s("olPlainHtml")), "从 1 开始的列表没有任何内联样式");
  }
}

console.log("");
if (fails) {
  console.log("✗ FAIL " + checks + " 项，失败 " + fails + " 项");
  process.exit(1);
}
console.log("✓ 全部通过（" + checks + " 项）");
