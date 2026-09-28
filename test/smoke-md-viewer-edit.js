"use strict";
/* Markdown 阅读器（renderer/app.js openMdViewer）支持「所见即所得」直接编辑：
 *   node test/smoke-md-viewer-edit.js
 * 钉住的口径：
 *   [1] 编辑态默认档 = 渲染出的正文本体即编辑区（contenteditable #mdViewerRich），
 *       不必先切源码；「源码」textarea 旧通道仍在（#mdViewerEditor / .viewer-editor）；
 *   [2] 正文 ↔ Markdown 与「✎ AI 审阅」同源（app-review.js 的 mdToRichHtml /
 *       richToMarkdown），保存写回磁盘仍是 Markdown；相对插图按 file:/// 显示、
 *       原相对引用记在 data-rv-src 上（往返不改写正文里的路径）；
 *   [3] 工具栏 = .rv-tool 方形按钮（复用 review.css），动作作用于 #mdViewerRich；
 *   [4] 保存 / 关窗 / 虚拟文档（技能正文）三条路径都取 mdViewerDraftText()，
 *       文件模式仍原样 fileWriteText 写回；
 *   [5] 样式（css/assist.css）与中英词条（i18n.js）齐备。
 */
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

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = src.indexOf("\n}", i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

const app = read("renderer/app.js");
const review = read("renderer/app-review.js");
const css = read("renderer/css/assist.css");
const i18n = read("renderer/i18n.js");

console.log("[1] 编辑态：默认所见即所得，源码只是可切的一档");
ok(
  app.indexOf('src: false,\n  raw: ""') >= 0 ||
    /\bsrc:\s*false,/.test(fnBody(app, "let _mdViewerState = {")),
  "_mdViewerState.src 存在（false = 所见即所得档）",
);
ok(
  app.indexOf("_mdViewerState.src = false;") >= 0 &&
    app.indexOf("/* 每次打开都回到「所见即所得」档：源码是可切的一档，不是默认入口 */") >= 0,
  "openMdViewer 每次打开回到所见即所得档",
);
const renderFn = fnBody(app, "function renderMdViewerContent(text)");
ok(renderFn.indexOf("if (_mdViewerState.src) {") >= 0, "渲染分「源码 / 所见即所得」两档");
ok(
  renderFn.indexOf("body.appendChild(buildMdViewerRichEditor(raw));") >= 0,
  "所见即所得档把渲染正文交给 buildMdViewerRichEditor",
);
ok(
  renderFn.indexOf('ta.id = "mdViewerEditor";') >= 0 &&
    renderFn.indexOf('ta.className = "viewer-editor";') >= 0,
  "源码档仍是全文可改 textarea（旧通道保留）",
);
ok(
  app.indexOf('id="mdViewerSrcBtn"') >= 0 &&
    app.indexOf("host.querySelector(\"#mdViewerSrcBtn\").onclick") >= 0,
  "头部有「源码 / 所见即所得」切档按钮并已接线",
);
const chromeFn = fnBody(app, "function applyMdViewerChrome()");
ok(
  chromeFn.indexOf("scb.style.display = _mdViewerState.editing ? \"\" : \"none\";") >= 0 &&
    chromeFn.indexOf('I18n.t("所见即所得")') >= 0,
  "切档按钮只在编辑态出现，文案随档位切换",
);

console.log("\n[2] 正文 ↔ Markdown 与审阅同源，写回磁盘仍是 Markdown");
const richFn = fnBody(app, "function mdViewerRichHtml(raw)");
ok(richFn.indexOf("mdToRichHtml(raw)") >= 0, "mdViewerRichHtml 走 app-review.js 的 mdToRichHtml");
const buildFn = fnBody(app, "function buildMdViewerRichEditor(raw)");
ok(buildFn.indexOf('ed.id = "mdViewerRich";') >= 0, "编辑区 id = mdViewerRich");
ok(buildFn.indexOf('ed.contentEditable = "true";') >= 0, "编辑区 contenteditable（直接改正文）");
ok(
  buildFn.indexOf('ed.className = "md md-viewer-doc md-viewer-rich";') >= 0,
  "编辑区沿用阅读器正文版式（.md-viewer-doc）+ 可编辑态类",
);
ok(
  buildFn.indexOf('dt.getData("text/plain")') >= 0 && buildFn.indexOf("mdViewerInsertText(t)") >= 0,
  "粘贴按纯文本插入（不把外部 HTML 塞进正文）",
);
const draftFn = fnBody(app, "function mdViewerDraftText()");
ok(
  draftFn.indexOf('host.querySelector("#mdViewerRich")') >= 0 &&
    draftFn.indexOf("richToMarkdown(rich)") >= 0,
  "mdViewerDraftText 用审阅同源的 richToMarkdown 序列化回 Markdown",
);
ok(
  draftFn.indexOf('host.querySelector("#mdViewerEditor")') >= 0,
  "源码档仍从 textarea 取正文",
);
ok(
  draftFn.indexOf("if (!_mdViewerState.dirty) return _mdViewerState.raw;") >= 0,
  "没改过正文就原样交回（不做无谓的 Markdown 归一化往返）",
);
const renderDirty = fnBody(app, "function renderMdViewerContent(text)");
ok(
  renderDirty.indexOf("_mdViewerState.dirty = false;") >= 0,
  "重建编辑区时把 dirty 归零",
);
const absFn = fnBody(app, "function mdViewerAbsImgSrc(html)");
ok(
  absFn.indexOf('img.setAttribute("data-rv-src", src);') >= 0 &&
    absFn.indexOf("rvFileUrl(") >= 0,
  "相对插图：data-rv-src 记原引用、src 换 file:/// 显示",
);
ok(
  review.indexOf("function richToMarkdown(root) {") >= 0 &&
    review.indexOf("function mdToRichHtml(raw) {") >= 0,
  "app-review.js 仍是 mdToRichHtml / richToMarkdown 的真源",
);

console.log("\n[3] 工具栏：.rv-tool 方形按钮，动作作用于 #mdViewerRich");
const tbFn = fnBody(app, "function buildMdViewerToolbar(tb)");
ok(tbFn.indexOf('b.className = "rv-tool";') >= 0, "按钮复用 review.css 的 .rv-tool 方形样式");
for (const act of [
  "h1", "h2", "h3", "p", "bold", "italic", "strike", "quote",
  "ul", "ol", "task", "hr", "link", "inlineCode", "code", "undo", "redo",
]) {
  ok(tbFn.indexOf('mk("' + act + '"') >= 0, "工具栏有动作 " + act);
}
const actFn = fnBody(app, "function mdViewerRichAct(action)");
ok(
  actFn.indexOf('exec("formatBlock", action)') >= 0 &&
    actFn.indexOf('exec("insertUnorderedList")') >= 0,
  "结构 / 列表动作走 execCommand，作用于当前富文本编辑区",
);
ok(
  actFn.indexOf("mdViewerInsertHtml(") >= 0 &&
    actFn.indexOf("mdViewerWrapInline(") >= 0 &&
    actFn.indexOf("mdViewerInsertLink()") >= 0,
  "插入类动作（水平线 / 任务清单 / 代码块 / 行内码 / 链接）已接",
);
ok(
  app.indexOf("function mdViewerInsertHtml(html)") >= 0 &&
    app.indexOf("function mdViewerCaretAfter(el)") >= 0,
  "插入后光标落到新内容之后",
);

console.log("\n[4] 保存 / 关窗 / 虚拟文档三条路径");
const saveFn = fnBody(app, "async function saveMdViewer()");
ok(
  saveFn.indexOf("const content = mdViewerDraftText();") >= 0,
  "文件模式取 mdViewerDraftText（所见即所得档也能写回）",
);
ok(
  saveFn.indexOf("const r = await window.api.fileWriteText(p, content);") >= 0,
  "文件模式仍原样写回磁盘",
);
ok(saveFn.indexOf("if (_mdViewerState.virtual) {") >= 0, "虚拟文档分支保持不变");
const closeFn = fnBody(app, "function closeMdViewer()");
ok(
  closeFn.indexOf("_mdViewerState.virtual && _mdViewerState.editing && _mdViewerState.onSave") >= 0,
  "关窗仍把虚拟文档草稿交回调用方（所见即所得档同样适用）",
);
ok(
  app.indexOf("openMdViewer(\"\", {") >= 0 ||
    read("renderer/app-plugins.js").indexOf("openMdViewer(\"\", {") >= 0,
  "技能正文仍走内置编辑器虚拟文档",
);

console.log("\n[5] 样式 / 词条");
for (const k of [".md-viewer-edit {", ".md-viewer-toolbar {", ".md-viewer-rich {"]) {
  ok(css.indexOf(k) >= 0, "css 有 " + k.replace(" {", ""));
}
ok(
  css.indexOf("position: sticky;") >= 0 && css.indexOf(".md-viewer-toolbar {") >= 0,
  "工具栏吸顶（长文档滚动时不离手）",
);
for (const k of [
  '"所见即所得": "WYSIWYG"',
  '"查看 / 编辑 Markdown 源码": "View / edit the Markdown source"',
  '"回到所见即所得直接编辑": "Back to WYSIWYG direct editing"',
  '"源码模式 · Ctrl+S 保存": "Source mode · press Ctrl+S to save"',
  '"编辑模式：所见即所得 · Ctrl+S 保存"',
  '"链接地址（https://…）": "Link URL (https://…)"',
  '"加粗": "Bold"',
  '"无序列表": "Bullet list"',
  '"行内代码": "Inline code"',
]) {
  ok(i18n.indexOf(k) >= 0, "英文词条：" + k.split(":")[0].replace(/"/g, ""));
}

console.log(
  (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
    checks +
    " 项" +
    (fails ? "，失败 " + fails + " 项" : "通过"),
);
process.exit(fails ? 1 : 0);
