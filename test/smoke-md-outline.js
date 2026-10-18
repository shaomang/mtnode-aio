"use strict";
/* 文本节点两处 Markdown 面（浏览态预览 · ✎ 编辑器）的排版口径 —— 纯 Node 冒烟
 *   node test/smoke-md-outline.js
 *
 * 本轮用户口径（已确认）：
 *   [1] 预览行间距太小 → 文本节点浏览态预览行高 1.7（基准那份 1.5 留给提示词框）、
 *       段落间距 6px；编辑器富文本区 1.7 / 段距 6px，源码档 textarea 同步 1.7（切档不跳行）；
 *   [2] 有序列表只写标准嵌套（`1.` 标记 + 缩进），显示层回到浏览器默认编号：
 *       早先那套用 CSS 计数器数出 1. → 1.1. → 1.1.1. 的层级号，以及把 `<ol start="3">`
 *       翻成计数器初值的翻译器，都按用户口径整体下线（`1.1.` 本来就不是合法的有序列表
 *       标记）；「在源码框里手写 `3.1. `」的自造键位也早一步下线，Tab 回落 4 空格缩进；
 *   [3] 失焦（未选中 = 浏览态）时正文就该是渲染后的 Markdown（文本节点 / 文本处理节点两处），
 *       解析与编辑态那颗「预览」按钮同源。
 *
 * 口径：整只 app-mdedit.js 原文进 vm 真跑（假 window / document / textarea），
 *   不抠函数体 —— 抠出来的副本测不到接线与事件层；样式与接线一律读源文件断言。
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
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const hasNot = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);
const show = (v) => JSON.stringify(v);

/* ═══════════ 假 DOM：够 app-mdedit.js 真跑（只读测试用，不进产品代码） ═══════════ */
function makeSandbox(opts) {
  const o = opts || {};
  /* 光标最近落在哪只 textarea 上：模拟浏览器的「当前可编辑元素」 */
  const focusBox = { el: null };
  function makeTa(value) {
    const el = {
      value: String(value == null ? "" : value),
      selectionStart: 0,
      selectionEnd: 0,
      listeners: {},
      inputs: 0,
      setSelectionRange(s, e) {
        this.selectionStart = s;
        this.selectionEnd = e;
        focusBox.el = this;
      },
      addEventListener(t, fn) {
        (this.listeners[t] = this.listeners[t] || []).push(fn);
      },
      dispatchEvent(ev) {
        if (ev && ev.type === "input") this.inputs++;
        for (const fn of (this.listeners[ev.type] || []).slice()) fn.call(this, ev);
        return true;
      },
    };
    return el;
  }
  const documentStub = {};
  if (o.execCommand) {
    documentStub.execCommand = function (cmd) {
      const el = focusBox.el;
      if (cmd !== "insertText" || !el) return false;
      const text = arguments[2];
      const s = el.selectionStart;
      const e = el.selectionEnd;
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.selectionStart = el.selectionEnd = s + String(text).length;
      el.dispatchEvent({ type: "input" }); /* 真浏览器里 execCommand 也会派发 input */
      return true;
    };
  }
  const sandbox = {
    console,
    Math,
    JSON,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    RegExp,
    Error,
    parseInt,
    document: documentStub,
    Event: function (type) {
      this.type = type;
    },
    window: null,
    globalThis: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-mdedit.js"), sandbox, { filename: "app-mdedit.js" });
  return { sandbox, makeTa, M: sandbox.MTMdEdit };
}

/* 正文里用 `|` 标光标（只允许一个）：`mkTextarea(makeTa, "3. |甲")`
   第三参是模块本身：按真实接线先 bindSource(ta)，再派发键位事件
   （不先接线，测到的只是「谁也没监听」，不是产品行为）。 */
function mkTextarea(makeTa, src, mod) {
  const i = src.indexOf("|");
  const v = i < 0 ? src : src.slice(0, i) + src.slice(i + 1);
  const ta = makeTa(v);
  const caret = i < 0 ? v.length : i;
  ta.selectionStart = ta.selectionEnd = caret;
  if (mod && typeof mod.bindSource === "function") mod.bindSource(ta);
  return ta;
}
/* 一次 keydown：默认「没被任何先前监听器消费」 */
function key(ta, k, props) {
  const ev = Object.assign(
    {
      type: "keydown",
      key: k,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    },
    props || {},
  );
  ta.dispatchEvent(ev);
  return ev;
}

const A = makeSandbox(); /* ① 回落路径：没有 execCommand */
const B = makeSandbox({ execCommand: true }); /* ② 原生写入路径 */
const M = A.M;
ok(!!M, "app-mdedit.js 真跑起来了，出口 window.MTMdEdit 就位");

/* ===================== [1] 自造的「层级序号」键位已下线 ===================== */
console.log("\n[1] 自造的层级序号（`3.1. ` 写进正文）整体下线，Tab 回落 4 空格");
{
  for (const k of ["tabOutline", "shiftTabOutline", "enterOutline", "bindOutline"]) {
    ok(typeof M[k] !== "function", "出口不再有 " + k + "（自造语法不进产品）");
  }
  ok(M._outlineProbe === undefined, "只读探针 _outlineProbe 随功能一起移除");
  ok(
    typeof M.tabSource === "function" && typeof M.shiftTabSource === "function",
    "标准键位 tabSource / shiftTabSource 仍在（4 空格缩进）",
  );
  const modSrc = read("renderer/app-mdedit.js");
  hasNot(modSrc, "outlineMarker", "模块里不再有「层级序号标记」的生成函数");
  hasNot(modSrc, "OUTLINE_RE", "模块里不再有层级序号正则");
  has(modSrc, "function tabSource(ta) {", "tabSource 本体仍在（全部源码档共用）");
  /* 三处接线点：全部回到 bindSource */
  const canvasSrc = read("renderer/app-canvas.js");
  const appSrc = read("renderer/app.js");
  has(canvasSrc, "MTMdEdit.bindSource(ta)", "文本节点板身正文框：接线 bindSource");
  /* app.js 里另有一处是内置 Markdown 阅读器的编辑态，同一条标准键位 */
  ok(
    (appSrc.match(/MTMdEdit\.bindSource\(ta\)/g) || []).length >= 1,
    "文本处理节点提示词框：接线 bindSource（实测 " +
      (appSrc.match(/MTMdEdit\.bindSource\(ta\)/g) || []).length +
      " 处，另一处是 Markdown 阅读器编辑态）",
  );
  for (const rel of ["renderer/app-canvas.js", "renderer/app.js", "renderer/app-textedit.js", "renderer/app-review.js"]) {
    hasNot(read(rel), "bindOutline", rel + "：没有残留的 bindOutline 接线");
  }
}

/* ===================== [2] Tab 的实际行为（真跑） ===================== */
console.log("\n[2] 真跑：源码档 Tab 插 4 空格、Shift+Tab 退一档（回落路径与原生写入路径一致）");
{
  {
    const ta = mkTextarea(A.makeTa, "- 甲\n  |- 甲一\n", M);
    const ev = key(ta, "Tab");
    ok(ta.value === "- 甲\n      - 甲一\n", "回落路径：Tab 插 4 空格（" + show(ta.value) + "）");
    ok(ev.defaultPrevented === true, "回落路径：Tab 被接管（焦点不跳走）");
    ok(ta.inputs === 1, "回落路径：改动派发一次 input（实测 " + ta.inputs + " 次）");
    const ta2 = mkTextarea(A.makeTa, "- 甲\n      |- 甲一\n", M);
    const ev2 = key(ta2, "Tab", { shiftKey: true });
    ok(ta2.value === "- 甲\n  - 甲一\n", "回落路径：Shift+Tab 退掉 4 空格（" + show(ta2.value) + "）");
    ok(ev2.defaultPrevented === true, "回落路径：Shift+Tab 被接管");
  }
  {
    const MB = B.M;
    const ta = mkTextarea(B.makeTa, "- 甲\n  |- 甲一\n", MB);
    const ev = key(ta, "Tab");
    ok(ta.value === "- 甲\n      - 甲一\n", "原生写入路径：值一致（" + show(ta.value) + "）");
    ok(ev.defaultPrevented === true, "原生写入路径：Tab 被接管");
    ok(ta.inputs === 1, "原生写入路径：input 只派发一次（实测 " + ta.inputs + " 次）");
    const ta2 = mkTextarea(B.makeTa, "- 甲\n      |- 甲一\n", MB);
    key(ta2, "Tab", { shiftKey: true });
    ok(ta2.value === "- 甲\n  - 甲一\n", "原生写入路径：Shift+Tab 一致");
    /* 没有缩进时不接管（放行浏览器跳焦点） */
    const ta3 = mkTextarea(B.makeTa, "|- 甲\n", MB);
    const ev3 = key(ta3, "Tab", { shiftKey: true });
    ok(ev3.defaultPrevented === false, "本行没有缩进时 Shift+Tab 不接管");
  }
}

/* ===================== [3] 层级号已下线：显示层不再自造 1.1. ===================== */
console.log("\n[3] 有序列表回到浏览器默认编号（1. / 2. / 3.），显示层不再自造 1.1. 层级号");
{
  const cssSrc = read("renderer/css/canvas.css");
  const rvCss = read("renderer/css/review.css");
  const walkSrc = read("renderer/app-review.js");
  /* ① 计数器整体移除（浏览态预览 / ✎ 编辑器两处都在） */
  hasNot(cssSrc, "mt-num", "浏览态预览：自造的 CSS 计数器已整体移除");
  hasNot(rvCss, "mt-num", "✎ 编辑器：自造的 CSS 计数器已整体移除");
  hasNot(walkSrc, "counter-reset", "富文本渲染不再往 <ol> 上塞内联计数器初值");
  hasNot(walkSrc, "rvApplyOlStart", "起始号翻译器已随计数器一起删除");
  hasNot(read("renderer/app.js"), "rvApplyOlStart", "浏览态预览的渲染入口也不再翻起始号");
  /* ② 只删序号花样：排版与嵌套列表照旧 */
  has(cssSrc, ".wf-node.browse .md.n-md-browse.n-md-browse-txt {",
    "浏览态预览的专属排版规则仍在（只删了计数器）");
  has(
    rvCss,
    ".review-editor ul, .review-editor ol, .rv-preview ul, .rv-preview ol { margin: .3em 0; padding-left: 1.6em; }",
    "嵌套列表的渲染口径原样（缩进与块间距不动）",
  );
  has(walkSrc, "function richToMarkdown(", "正文序列化本体仍在（只下线显示层那套序号）");
  /* ③ 正文只写 Markdown 认得的标记（`1.` + 缩进）：同一层按真实序号递增，
      起始号读 <ol start>，显示靠浏览器原生编号。 */
  has(walkSrc, 'const mark = (unordered ? "- " : num++ + ". ") + boxLead;',
    "列表回写按真实序号（同一层从 start 起递增），不自造层级号");
  has(walkSrc, 'let num = Number((list.getAttribute && list.getAttribute("start")) || 1) || 1;',
    "起始号从 <ol start> 取（从 3 开始的列表不会被打回 1.）");
  ok(walkSrc.indexOf('"1.1. "') < 0 && walkSrc.indexOf("3.1. ") < 0,
    "正文里不会出现 `1.1. ` / `3.1. ` 这类自造标记");
}

/* ===================== [4] 行距：预览 1.7 / 段距 6px，编辑器同值 ===================== */
console.log("\n[4] 行距与段距（用户口径：预览行间距太小，适度增大；切档不跳行）");
{
  const cssSrc = read("renderer/css/canvas.css");
  const rvCss = read("renderer/css/review.css");
  /* ① 浏览态预览（文本节点这一面） */
  const browse = /\.wf-node\.browse \.md\.n-md-browse\.n-md-browse-txt \{([^}]*)\}/.exec(cssSrc);
  ok(!!browse, "浏览态预览有文本节点专属的排版规则（.n-md-browse-txt）");
  has(browse ? browse[1] : "", "line-height: 1.7", "浏览态预览行高 1.7");
  has(
    cssSrc,
    ".wf-node.browse .md.n-md-browse.n-md-browse-txt>.ntv-md>p+p,",
    "浏览态预览：段与段之间 6px（选择器穿过 .ntv-md 壳，否则退回 .md 的口径）",
  );
  const para = /\.n-md-browse-txt>\.ntv-md>p\+p,[\s\S]{0,200}?\{([^}]*)\}/.exec(cssSrc);
  has(para ? para[1] : "", "margin-top: 6px", "段距 6px（旧 5px 已作废）");
  /* ② 板身正文框（textarea）同高：切档行位不跳 */
  const ta = /\.wf-node\.in \.n-text \{([^}]*)\}/.exec(cssSrc);
  ok(!!ta, "文本节点板身正文框有自己的行高规则（.wf-node.in .n-text）");
  has(ta ? ta[1] : "", "line-height: 1.7", "板身正文框行高 1.7（与预览同高）");
  /* ③ ✎ 编辑器 */
  const edPara = /\.txmd-dlg \.review-editor p,([\s\S]{0,120}?)\{([^}]*)\}/.exec(rvCss);
  ok(!!edPara, "编辑器正文的段距规则在位（.txmd-dlg）");
  has(edPara ? edPara[2] : "", "margin: 6px 0", "编辑器段距 6px（旧 .4em ≈ 5.2px 已作废）");
  const edSrc = /\.txmd-dlg \.rv-src \{([^}]*)\}/.exec(rvCss);
  ok(!!edSrc, "编辑器源码档 textarea 的行高规则在位");
  has(edSrc ? edSrc[1] : "", "line-height: 1.7", "源码档行高 1.7（切档行位不跳）");
  has(rvCss, "line-height: 1.7;", "编辑器基准行高仍是 1.7");
}

/* ===================== [4b] 水平线看得见 / 待办项不再双标记 ===================== */
console.log("\n[4b] 水平线与待办勾选框（用户口径：横隔线保存后就消失、待办前多一个圆点）");
{
  const cssSrc = read("renderer/css/canvas.css");
  const rvCss = read("renderer/css/review.css");
  /* `<hr>` 落进正文是靠序列化（见 smoke-md-edit-ux 的 [5]），看得见则是这一条：
     全站 `.md hr` 是 0.67px 虚线 --bd，深色面板里基本读不出来；画布还按缩放跑，1px 落屏只有 0.67。 */
  const boardHr = /\.wf-node\.browse \.md\.n-md-browse-txt hr \{([^}]*)\}/.exec(cssSrc);
  ok(!!boardHr, "画布文本节点预览的水平线有专属规则");
  has(boardHr ? boardHr[1] : "", "border-top: 1.5px solid var(--bd2)", "画布预览水平线：1.5px 实线");
  const edHr = /\.txmd-dlg hr,[\s\S]{0,220}?\{([^}]*)\}/.exec(rvCss);
  ok(!!edHr, "编辑器 / 审阅窗 / 只读预览共用的水平线规则在位");
  has(edHr ? edHr[1] : "", "border-top: 1.5px solid var(--bd2)", "编辑器水平线同为 1.5px 实线");
  /* marked 把 `- [ ]` 渲染成无 class 的 <ul><li><input type=checkbox disabled>，
     不按结构选就成「圆点 + 复选框」双标记。 */
  has(rvCss, 'li:has(> input[type="checkbox"])', "待办项按结构选中（marked 的任务列表没有 class 可依）");
  has(rvCss, "list-style: none", "待办项只留复选框，圆点撤掉");
}

/* ===================== [5] 失焦（浏览态）渲染 Markdown ===================== */
console.log("\n[5] 失焦（未选中 = 浏览态）：这两处正文按 Markdown 预览渲染");
{
  const canvasSrc = read("renderer/app-canvas.js");
  const cssSrc = read("renderer/css/canvas.css");
  has(canvasSrc, "function browseMdPreviewEl(text, node) {", "浏览态 Markdown 预览块已就位");
  has(canvasSrc, "MTMdPreview.html(node, raw)", "解析与编辑态那颗「预览」按钮同源（previewHtml）");
  has(canvasSrc, "n-md-browse", "预览块带自己的标记类（CSS 与预览档并排写）");
  has(
    canvasSrc,
    '(node && node.kind === "input_text" ? " n-md-browse-txt" : "")',
    "只有文本节点那一面带 n-md-browse-txt 标记（提示词框维持旧口径）",
  );
  has(
    canvasSrc,
    'nodeViewIsEmpty(raw) || (typeof nodeViewIsLong === "function" && nodeViewIsLong(raw))',
    "空正文 / 超长仍走既有护栏（回落 browseTextEl，不在预览块里另造一套）",
  );
  has(
    canvasSrc,
    "const v = browseMdPreviewEl(node.text, node) || browseTextEl(node.text, node);",
    "文本节点板身正文框：失焦时走 Markdown 预览块（模块缺席才回落）",
  );
  has(canvasSrc, "function browsePromptViewEl(node) {", "提示词只读视图多了一层范围判据");
  has(canvasSrc, 'if (node && node.kind === "proc_text")', "只有 proc_text 走预览块（proc_image 维持原口径）");
  has(canvasSrc, "const pv = browsePromptViewEl(node);", "browseProcBody 用上这层判据");
  has(canvasSrc, "NODE_BROWSE_BODY.proc_image = browseProcBody;", "proc_image 的登记没动");
  /* 范围：只读展示（node.ro）/ 批量条目 / 继承只读仍走 browseTextEl */
  const itStart = canvasSrc.indexOf("NODE_BROWSE_BODY.input_text = function (node, body) {");
  const roBranch = canvasSrc.slice(
    itStart,
    canvasSrc.indexOf("if (inputInherited(node)) {", itStart),
  );
  has(roBranch, "browseTextEl(node.text, node)", "只读展示（node.ro）分支原样不动");
  hasNot(roBranch, "browseMdPreviewEl", "只读展示分支没被接上预览块（本轮范围外）");
  ok(
    (canvasSrc.match(/browseMdPreviewEl\(/g) || []).length === 3,
    "全文件只有「一处定义 + 两处调用」（实测 " +
      (canvasSrc.match(/browseMdPreviewEl\(/g) || []).length +
      "）",
  );
  /* 样式：预览块的 @ 配色与胶囊与预览档并排（同一份色值，不各写一套）。
     注意 canvas.css 是 CRLF 行尾，断言只按「单行选择器」比，不跨行拼字符串。 */
  has(cssSrc, ".n-md-prev .at-ref-node,", "预览档 @节点 选择器在（与下面那条并排）");
  has(cssSrc, ".n-md-browse .at-ref-node {", "浏览态预览块的 @节点 青色（与预览档同一条规则）");
  has(cssSrc, ".n-md-prev .at-ref-tag,", "预览档 @标签 选择器在");
  has(cssSrc, ".n-md-browse .at-ref-tag {", "浏览态预览块的 @标签 紫色（与预览档同一条规则）");
  has(cssSrc, ".n-md-prev .n-md-pill,", "预览档胶囊选择器在");
  has(cssSrc, ".n-md-browse .n-md-pill {", "浏览态预览块的胶囊样式（与预览档同一条规则）");

  /* 基准那一份（提示词框）仍是「与编辑框逐条同值」：等宽 mono 12.5px · 行高 1.5 ·
     内边距 6px。文本节点那一面在上面的 [4] 里另立 1.7 / 6px 的覆盖。
     取规则体再断言，避免只钉「有这一行字」。canvas.css 是 CRLF，[^}]* 里含 \r\n 不影响。 */
  const spacing = /\.wf-node\.browse \.md\.n-md-browse \{([^}]*)\}/.exec(cssSrc);
  ok(!!spacing, "预览块有自己的一条基准排版规则（.wf-node.browse .md.n-md-browse）");
  const sbody = spacing ? spacing[1] : "";
  has(sbody, "font-family: var(--mono)", "字体 = 编辑态同一份等宽（切档字面不跳）");
  has(sbody, "font-size: 12.5px", "字号 = 编辑态 12.5px");
  has(sbody, "line-height: 1.5", "基准行高 1.5（提示词框与旁边的 .n-text 同像素）");
  has(sbody, "padding: 6px", "内边距 = 编辑态 6px（左右仍不动：20px 由 .n-body 让给接线排）");
  const hblock = /\.wf-node\.browse \.md\.n-md-browse h1,[\s\S]{0,240}?\{([^}]*)\}/.exec(cssSrc);
  has(hblock ? hblock[1] : "", "margin: 0", "标题不再自带上下间距（h1–h4 一条规则，四条选择器并排）");
  ok(
    /\.wf-node\.browse \.md\.n-md-browse h1 \{[\s\S]{0,80}?font-size: 14px/.test(cssSrc) &&
      /\.wf-node\.browse \.md\.n-md-browse h2 \{[\s\S]{0,80}?font-size: 13px/.test(cssSrc),
    "标题只在正文基准上微放大（h1 14 / h2 13，橙色加粗照旧）",
  );
  has(
    cssSrc,
    ".wf-node.browse .md.n-md-browse>.ntv-md>p+p",
    "段落紧挨着，只留块与块之间的一档空白（选择器穿过 .ntv-md 壳，否则退回 .md 的 p 4px）",
  );
  has(cssSrc, ".wf-node.browse .md.n-md-browse ul,", "列表块的上间距与预览档同值（ul / ol）");
  has(cssSrc, ".wf-node.browse .md.n-md-browse li {", "列表项之间的口径在（li）");
  /* 范围：只动预览块自己 —— 全浏览态共用的 .md 与别处 Markdown 面的口径一个字没改 */
  ok(
    !/\.wf-node\.browse \.md \{[^}]*padding/.test(cssSrc),
    "没把内边距写进全浏览态共用的 .md 规则（输出区 / 手册 / 其它节点不受影响）",
  );
  has(cssSrc, "line-height: 1.7", "全站 .md 基准的阅读行距还在（别处 Markdown 面原样）");

  /* 装载顺序：浏览态那一屏是**启动装载期**就渲染出来的，而 applyNodeForm 只在形态真的变
     （dataset.nodeForm 从 browse 变 edit 再变回来）时才重建 body —— 预览档若晚于首遍渲染
     就位，首屏就永远停在纯文本回落形态上（实测坑：重启应用后未选中的正文仍是原文本，
     点一下选中再取消才变成预览）。所以 index.html 里它必须排在 app-canvas.js / app-boot.js 之前。 */
  const htmlSrc = read("renderer/index.html");
  const atPreview = htmlSrc.indexOf('src="app-mdpreview.js"');
  const atCanvas = htmlSrc.indexOf('src="app-canvas.js"');
  const atBoot = htmlSrc.indexOf('src="app-boot.js"');
  ok(
    atPreview > 0 && atCanvas > 0 && atPreview < atCanvas,
    "app-mdpreview.js 排在 app-canvas.js 之前（浏览态渲染器调用期一定取得到）",
  );
  ok(
    atBoot > 0 && atPreview < atBoot,
    "app-mdpreview.js 排在 app-boot.js 之前（首遍装载渲染时预览块已在位）",
  );
}

/* ===================== [6] 既有口径没被顺手改掉 ===================== */
console.log("\n[6] 既有口径不动：预览档、detectViewLang、其它只读视图");
{
  const modSrc = read("renderer/app-mdpreview.js");
  const viewSrc = read("renderer/app-nodeview.js");
  has(modSrc, "rec.ta.classList.toggle(\"n-md-src-hidden\", on)", "编辑态预览档的切档逻辑原样");
  has(modSrc, "window.MTMdPreview = {", "预览档出口原样");
  has(viewSrc, "function detectViewLang(text) {", "detectViewLang 本体未动（全站其它只读视图口径不变）");
  has(
    viewSrc,
    'if (st.md > 0) return "md";',
    "保守判定原样：有 Markdown 信号才 md（列表仍不是信号 —— 本轮在调用侧绕开它，不改它）",
  );
}

console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
process.exit(fails ? 1 : 0);
