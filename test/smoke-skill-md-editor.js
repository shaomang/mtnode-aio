"use strict";
/* 设置 · 添加 / 编辑技能 → 正文一律走内置 Markdown 阅读 / 编辑器
 *   node test/smoke-skill-md-editor.js
 * 钉住的口径：
 *   [1] 内置 Markdown 阅读器（renderer/app.js openMdViewer）支持「虚拟文档」：
 *       opts.content 直接给正文、opts.edit 进编辑态、opts.readOnly 只读、opts.onSave 收正文；
 *   [2] 虚拟文档保存 / 关窗（✕ / Esc）都把正文交回调用方，绝不写磁盘（fileWriteText 只在文件模式里）；
 *   [3] 设置 · 扩展能力管理（renderer/app-plugins.js）里技能正文不再用裸 textarea，
 *       改「✎ 用内置 Markdown 编辑器」入口 + 渲染预览；草稿仍由 skillAdd 写入 SKILL.md；
 *   [4] 内置技能只读：正文用内置 Markdown 阅读器打开，不再落到 <pre> 里看原文；
 *   [5] 样式（css/dsh.css）与中英词条（i18n.js）齐备，且阅读器浮层盖在扩展能力管理窗之上。
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
/* 取某函数体：从签名起到「行首 }」为止（够静态断言用，不 pretending 解析 JS） */
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = src.indexOf("\n}", i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

const app = read("renderer/app.js");
const plugins = read("renderer/app-plugins.js");
const css = read("renderer/css/dsh.css");
const i18n = read("renderer/i18n.js");

console.log("[1] 内置 Markdown 阅读器 · 虚拟文档模式");
ok(
  app.indexOf('const virtual = typeof opts.content === "string";') >= 0,
  "openMdViewer 认 opts.content = 虚拟文档（不解析磁盘路径）",
);
ok(
  app.indexOf(
    "_mdViewerState.onSave = typeof opts.onSave === \"function\" ? opts.onSave : null;",
  ) >= 0,
  "onSave 回调登记进 _mdViewerState",
);
ok(
  app.indexOf("_mdViewerState.editing = virtual ? !!opts.edit && !opts.readOnly : false;") >=
    0,
  "opts.edit 直接进编辑态 · opts.readOnly 只读",
);
const openFn = fnBody(app, "async function openMdViewer(filePath, opts)");
ok(
  openFn.indexOf("renderMdViewerContent(opts.content);") >= 0 &&
    openFn.indexOf("renderMdViewerContent(opts.content);") <
      openFn.indexOf("const rr = await window.api.fileReadText(resolved);"),
  "虚拟文档不走 fileReadText，直接渲染传入正文",
);
ok(
  app.indexOf('_mdViewerState.virtual ? "none" : ""') >= 0,
  "虚拟文档隐藏「刷新 / 位置」（没有磁盘文件可重载定位）",
);
ok(
  app.indexOf('eb.style.display = _mdViewerState.readOnly ? "none" : "";') >= 0,
  "只读文档不显示「编辑」入口",
);

console.log("\n[2] 保存 / 关窗：正文交回调用方，不写磁盘");
const saveFn = fnBody(app, "async function saveMdViewer()");
ok(saveFn.indexOf("if (_mdViewerState.virtual) {") >= 0, "saveMdViewer 先分虚拟文档支");
const vBlock = saveFn.slice(
  saveFn.indexOf("if (_mdViewerState.virtual) {"),
  saveFn.indexOf("const p = _mdViewerState.path;"),
);
ok(
  vBlock.indexOf("await _mdViewerState.onSave(content)") >= 0,
  "虚拟文档保存 = 调 onSave（不 fileWriteText）",
);
ok(vBlock.indexOf("fileWriteText") < 0, "虚拟文档分支里没有 fileWriteText");
ok(
  saveFn.indexOf("const r = await window.api.fileWriteText(p, content);") >= 0,
  "文件模式仍原样写回磁盘",
);
const closeFn = fnBody(app, "function closeMdViewer()");
ok(
  closeFn.indexOf(
    "_mdViewerState.virtual && _mdViewerState.editing && _mdViewerState.onSave",
  ) >= 0,
  "关窗（✕ / Esc）把编辑中的虚拟文档正文交回，不丢草稿",
);
ok(
  closeFn.indexOf("closeMdViewer") < 0 ||
    closeFn.indexOf("host.classList.remove") >= 0,
  "关窗仍只是收浮层（不重建 DOM）",
);

console.log("\n[3] 技能表单：正文走内置编辑器（不再裸 textarea）");
ok(
  plugins.indexOf("const body = extTextArea(") < 0,
  "技能表单已无 extTextArea 正文框",
);
ok(
  plugins.indexOf('mdBtn.textContent = I18n.t("✎ 用内置 Markdown 编辑器");') >= 0,
  "表单给出「✎ 用内置 Markdown 编辑器」入口",
);
ok(
  plugins.indexOf('openMdViewer("", {') >= 0 &&
    plugins.indexOf('content: String(bodyText || ""),') >= 0,
  "入口以虚拟文档打开内置编辑器（content = 当前草稿）",
);
ok(
  plugins.indexOf('bodyText = String(text == null ? "" : text);') >= 0,
  "编辑器保存回填 bodyText",
);
ok(plugins.indexOf("body: bodyText,") >= 0, "skillAdd 提交的是编辑器里的正文");
ok(
  plugins.indexOf("paintSkillBody();") >= 0 &&
    plugins.indexOf('mdPrev.className = "dsh-skill-md-prev md";') >= 0,
  "表单里保留渲染预览（点预览同样进编辑器）",
);
ok(
  plugins.indexOf("mdPrev.onclick = openSkillBodyEditor;") >= 0,
  "预览可点，直接用内置编辑器打开",
);

console.log("\n[4] 内置技能只读：用内置阅读器打开");
ok(
  plugins.indexOf("async function openSkillMarkdownViewer(s, opts)") >= 0,
  "新增 openSkillMarkdownViewer（统一走内置 Markdown 阅读 / 编辑器）",
);
ok(
  plugins.indexOf("await openSkillMarkdownViewer(s, { readOnly: true });") >= 0,
  "内置技能「阅读」= 只读打开",
);
ok(
  plugins.indexOf("await openSkillMarkdownViewer(s, { readOnly: true });") >= 0 &&
    plugins.indexOf('extState("skill").editor = { mode: "edit", data: s };') >= 0,
  "本机技能仍走表单（含内置编辑器），内置技能不进编辑表单",
);

console.log("\n[5] 样式 / 词条 / 层级");
ok(css.indexOf(".dsh-skill-md-prev {") >= 0, "css 有 .dsh-skill-md-prev 预览框");
ok(css.indexOf(".dsh-skill-md-prev.empty {") >= 0, "空正文时预览框收起");
ok(css.indexOf(".dsh-skill-md .mini {") >= 0, "入口按钮左对齐（不继承表单 mini 的 flex-end）");
for (const k of [
  '"Markdown 编辑器": "Markdown Editor"',
  '"✎ 用内置 Markdown 编辑器": "✎ Use the built-in Markdown editor"',
  '"内置 Markdown 编辑器不可用": "Built-in Markdown editor unavailable"',
  '" · 只读": " · read-only"',
  '"阅读": "Read"',
]) {
  ok(i18n.indexOf(k) >= 0, "英文词条：" + k.split(":")[0].replace(/"/g, ""));
}
const zDlg = /\.dsh-plugins-dlg\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
const zMd = /\.yaml-viewer-dlg\s*\{[^}]*z-index:\s*(\d+)/.exec(read("renderer/css/assist.css"));
ok(
  zDlg && zMd && Number(zMd[1]) > Number(zDlg[1]),
  "Markdown 阅读器浮层盖在扩展能力管理窗之上（" +
    (zMd && zMd[1]) +
    " > " +
    (zDlg && zDlg[1]) +
    "）",
);

console.log(
  (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
    checks +
    " 项" +
    (fails ? "，失败 " + fails + " 项" : "通过"),
);
process.exit(fails ? 1 : 0);
