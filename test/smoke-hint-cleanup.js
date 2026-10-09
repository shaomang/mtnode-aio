/* test/smoke-hint-cleanup.js — 提示冗余静态检查（纯静态 · 零依赖 · 不起 Electron）
 * ============================================================================
 * 运行：node test/smoke-hint-cleanup.js
 *
 * 背景（需求「界面提示冗余清理」）：
 *   四类提示被判为冗余并已清理，本脚本把口径钉死，防止它们再长回来 ——
 *     ① 与标签重复的气泡：同一条文案既当可见文字 / aria-label，又当 hover 提示；
 *     ② 附带键位的提示文案：「撤销（Ctrl+Z）」这类把键位写进提示的写法；
 *     ③ 自述元提示：「鼠标移开 1 秒后自动关闭」这类讲提示自己怎么消失的句子；
 *     ④ 面板内逐字重抄表单的字段速查：面板已逐字段回显，提示里不再抄一遍规格。
 *
 * 口径（只扫静态材料，不渲染）：
 *   · 扫 renderer/ 下的 *.html / *.js / *.css；i18n.js 只当字典用。
 *   · 判定只认硬证据（字面量 / 同一个 I18n.t 键 / 逐字相同），变量与三元拼出来的
 *     值判不准就放过 —— 宁漏不误报。
 *   · 每个检查都给出「文件:行 · 命中文本」，红的时候直接能定位。
 *   · 无白名单兜底；唯一两条例外写在对应小节注释里（都注明理由）。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer");
const I18N_REL = "renderer/i18n.js";

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* ── 读全部静态材料（一次读盘，后面各检查共用） ───────────────────────── */
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (/\.(js|html|css)$/.test(name)) out.push(abs);
  }
  return out;
}
const FILES = walk(RENDERER, []).map((abs) => ({
  abs,
  rel: path.relative(ROOT, abs).replace(/\\/g, "/"),
  text: fs.readFileSync(abs, "utf8"),
}));
const fileOf = (rel) => FILES.find((f) => f.rel === rel);
const HTML = fileOf("renderer/index.html");
const I18N = fileOf(I18N_REL);
const JS_FILES = FILES.filter((f) => f.rel.endsWith(".js") && f.rel !== I18N_REL);

if (!HTML || !I18N) {
  console.log("FAIL  缺关键文件：renderer/index.html 或 renderer/i18n.js");
  process.exit(1);
}

/* 行号工具：按字符下标算 1-based 行号 */
function lineAt(text, idx) {
  return text.slice(0, idx).split("\n").length;
}
/* 正则全量命中 → {line, text} */
function hitsOf(text, re) {
  const out = [];
  const r = new RegExp(re.source, re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g");
  let m;
  while ((m = r.exec(text))) {
    out.push({ line: lineAt(text, m.index), text: (m[0] || "").replace(/\s+/g, " ").trim() });
    if (r.lastIndex === m.index) r.lastIndex++;
  }
  return out;
}
/* i18n 字典键（4 空格缩进的顶层键） */
function dictKeys() {
  const out = [];
  const re = /^ {4}"((?:[^"\\]|\\.)+)":/gm;
  let m;
  while ((m = re.exec(I18N.text))) out.push({ key: m[1], line: lineAt(I18N.text, m.index) });
  return out;
}
const attrOf = (tag, name) => {
  const m = tag.match(new RegExp("\\b" + name + '="([^"]*)"'));
  return m ? m[1] : "";
};
/* 可见文字：开标签与第一个 "<" 之间的文本（按钮内文的第一段文字） */
const visibleOf = (tag) => {
  const m = tag.match(/>([^<]*)/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
};
/* 「同一个字面量 / 同一个 I18n.t 键」归一化：不是硬证据就返回空串 */
const strip = (s) => String(s || "").replace(/\s+/g, "");
const hardValue = (s) => {
  const t = strip(s);
  const q = t.match(/^"(?:[^"\\]|\\.)*"$/);
  if (q) return q[0];
  const c = t.match(/^(?:I18n\.t|appsT|T)\(("(?:[^"\\]|\\.)*")\)$/);
  return c ? c[1] : "";
};

/* ── ① 与标签重复的气泡 ──────────────────────────────────────────────────
   同一元素上 data-i18n-title / data-tip / title 与 aria-label 或可见文字**逐字相同**
   = 气泡没带来任何新信息（顶栏第二排就是这一类的典型）。 */
console.log("[1] 禁：与标签重复的气泡（同一元素上提示 ≡ aria-label / 可见文字）");
{
  const TAGS = HTML.text.match(/<[a-zA-Z][^>]*>/g) || [];
  const sameAsAria = [];
  const sameAsVisible = [];
  for (const tag of TAGS) {
    const tip = attrOf(tag, "data-i18n-title") || attrOf(tag, "data-tip") || attrOf(tag, "title");
    if (!tip) continue;
    const aria = attrOf(tag, "aria-label");
    const visible = visibleOf(tag);
    const id = attrOf(tag, "id") || attrOf(tag, "class");
    if (aria && aria === tip) sameAsAria.push(id + " → " + tip);
    if (visible && visible === tip) sameAsVisible.push(id + " → " + tip);
  }
  ok(
    sameAsAria.length === 0,
    "index.html 没有「提示 ≡ aria-label」的元素（命中：" + (sameAsAria.join(" ; ") || "无") + "）",
  );
  ok(
    sameAsVisible.length === 0,
    "index.html 没有「提示 ≡ 可见文字」的元素（命中：" + (sameAsVisible.join(" ; ") || "无") + "）",
  );

  /* 动态生成的按钮（renderer/*.js 里 createElement / innerHTML 之后成对赋值）：
     两条紧邻且逐字相同 = 同一个气泡写了两遍。只认硬证据（字面量 / 同一 I18n.t 键）；
     变量与三元拼出来的值判不准就放过 —— 宁漏不误报。 */
  const dynDup = [];
  const DYN_RE = new RegExp(
    [
      "(?:\\.title\\s*=\\s*([^;\\n]+);[\\s\\S]{0,200}?\\n[^\\n]*\\.setAttribute\\(\\s*[\"']aria-label[\"']\\s*,\\s*([^;\\n]+)\\))",
      "|(?:\\.setAttribute\\(\\s*[\"']aria-label[\"']\\s*,\\s*([^;\\n]+)\\)[\\s\\S]{0,200}?\\n[^\\n]*\\.title\\s*=\\s*([^;\\n]+))",
    ].join(""),
    "g",
  );
  for (const f of JS_FILES) {
    DYN_RE.lastIndex = 0;
    let m;
    while ((m = DYN_RE.exec(f.text))) {
      const a = hardValue(m[1] || m[4]);
      const b = hardValue(m[2] || m[3]);
      if (a && b && a === b)
        dynDup.push(f.rel + ":" + lineAt(f.text, m.index) + " · " + a.slice(0, 60));
      if (DYN_RE.lastIndex === m.index) DYN_RE.lastIndex++;
    }
  }
  ok(
    dynDup.length === 0,
    "renderer/*.js 没有紧邻成对赋值的「title ≡ aria-label」（命中：" + (dynDup.join(" ; ") || "无") + "）",
  );
}

/* ── ② 附带键位的提示文案 ────────────────────────────────────────────────
   提示里不再写「（Ctrl+Z）」「（Esc）」这类键位教导：键位由 renderer/app-keys.js
   从 index.html 的 data-shortcut 生效，提示里再来一遍就是第二轮冗余。
   只查提示面（data-i18n-title / data-tip / title），不查快捷键真源本身。 */
console.log("\n[2] 禁：提示文案里附带键位（键位真源只有一个：data-shortcut）");
{
  const PAREN_KEY = /（[^）]{0,12}(?:Ctrl|Shift|Alt|Esc|⌘|Cmd)[^）]{0,12}）/;
  const tipKeyHits = [];
  const TAGS = HTML.text.match(/<[a-zA-Z][^>]*>/g) || [];
  for (const tag of TAGS) {
    const tip = attrOf(tag, "data-i18n-title") || attrOf(tag, "data-tip") || attrOf(tag, "title");
    if (tip && (PAREN_KEY.test(tip) || /快捷键\s*[A-Za-z0-9]/.test(tip)))
      tipKeyHits.push((attrOf(tag, "id") || attrOf(tag, "class")) + " → " + tip);
  }
  ok(
    tipKeyHits.length === 0,
    "index.html 的提示面没有「（Ctrl+…）」式键位（命中：" + (tipKeyHits.join(" ; ") || "无") + "）",
  );

  /* JS 里动态设置的 title / data-tip：整条赋值语句抓下来再判 */
  const jsKeyHits = [];
  for (const f of JS_FILES) {
    for (const h of hitsOf(f.text, /(?:\.title\s*=|\.setAttribute\(\s*["']data-tip["']\s*,)[^;\n]*/g)) {
      if (PAREN_KEY.test(h.text))
        jsKeyHits.push(f.rel + ":" + h.line + " · " + h.text.replace(/\s+/g, " ").slice(0, 70));
    }
  }
  ok(
    jsKeyHits.length === 0,
    "renderer/*.js 动态设置的 title / data-tip 里没有「（Ctrl+…）」式键位（命中：" +
      (jsKeyHits.join(" ; ") || "无") +
      "）",
  );

  /* 机制回归：旧写法（把键位拼进提示）必须不再出现 */
  ok(
    !/t\("快捷键 \{k\}", \{ k: sc \}\)/.test(I18N.text),
    "i18n.applyDom 不再把 data-shortcut 拼进提示文案（「 · 快捷键 X」已删）",
  );
  const KEYS = fileOf("renderer/app-keys.js");
  ok(
    !!KEYS && /data-shortcut/.test(KEYS.text),
    "键位仍由 renderer/app-keys.js 读 index.html 的 data-shortcut 生效（删的是提示，不是快捷键）",
  );
}

/* ── ③ 自述元提示 ────────────────────────────────────────────────────────
   「鼠标移开 1 秒后自动关闭」这类句子讲的是提示自己的生命周期，对用户没有信息量；
   要留的只有「讲功能」的句子（如「点开结果后自动关闭」说的是搜索结果面板的行为，
   句中不含「提示 / 气泡 / 说明 / 小窗」这些自述词，故不会被本规则命中）。 */
console.log("\n[3] 禁：自述元提示（讲提示自己怎么消失的句子）");
{
  const META =
    /(提示|气泡|说明|tooltip|小窗)[^。；]{0,12}(自动关闭|自动消失|移开|点外部|点击别处)|(自动关闭|自动消失|移开后|移开\s*\d|点外部|点击别处)[^。；]{0,12}(提示|气泡|说明|tooltip|小窗)/;
  const metaHits = dictKeys().filter((d) => META.test(d.key));
  ok(
    metaHits.length === 0,
    "i18n 字典没有「讲自己怎么消失」的提示词条（命中：" +
      (metaHits.map((d) => d.key).join(" ; ") || "无") +
      "）",
  );
  ok(dictKeys().length > 1000, "字典解析口径可用（键 " + dictKeys().length + " 条）");

  /* 元提示曾经挂在节点说明小窗的脚注上：连同它的 CSS 类一起清掉，不留半截 */
  const footHits = [];
  for (const f of FILES) {
    for (const h of hitsOf(f.text, /node-help-tip-foot/g)) footHits.push(f.rel + ":" + h.line);
  }
  ok(
    footHits.length === 0,
    "「节点说明小窗脚注」（.node-help-tip-foot）连同 CSS 一起清掉（残留：" +
      (footHits.join(" ; ") || "无") +
      "）",
  );
  ok(
    /node-help-tip-body/.test(fileOf("renderer/app-nodehelp.js").text),
    "节点说明小窗本体仍在（删的只是脚注元提示，不是说明功能）",
  );
}

/* ── ④ 逐字重抄表单的字段速查 ────────────────────────────────────────────
   面板里已经逐字段回显规格（label + 输入框），提示里再抄一份字段表 = 第四类冗余。
   判定物：文案里不再出现「字段速查 / 字段清单」式自述标签。
   注释里描述数据结构的“字段表”不算文案，故只看 JS 的字符串字面量与 i18n 字典键。 */
console.log("\n[4] 禁：面板内逐字重抄表单的字段速查");
{
  const LABEL = /字段速查|字段清单/;
  const strHits = [];
  for (const f of JS_FILES) {
    for (const h of hitsOf(f.text, /"(?:[^"\\\n]|\\.)*"/g)) {
      if (LABEL.test(h.text)) strHits.push(f.rel + ":" + h.line + " · " + h.text.slice(0, 60));
    }
  }
  ok(
    strHits.length === 0,
    "renderer/*.js 的文案字面量里没有「字段速查 / 字段清单」式重抄（命中：" +
      (strHits.join(" ; ") || "无") +
      "）",
  );
  const dictLabelHits = dictKeys()
    .filter((d) => LABEL.test(d.key))
    .map((d) => "i18n.js:" + d.line + " · " + d.key);
  ok(
    dictLabelHits.length === 0,
    "i18n 字典里没有「字段速查 / 字段清单」词条（命中：" + (dictLabelHits.join(" ; ") || "无") + "）",
  );

  /* 清单要点只留面板没交代的几条：id / title / version 由面板逐字段回显，不再进提示 */
  const PLUGINS = fileOf("renderer/app-plugins.js");
  ok(!!PLUGINS && /I18n\.t\("清单要点"\)/.test(PLUGINS.text), "插件清单的摘要标题改为「清单要点」");
  ok(
    !!PLUGINS && !/id\s{2,}必填|version\s{2,}插件版本号|minAppVersion\s+可选/.test(PLUGINS.text),
    "清单要点里不再逐行抄 id / version / minAppVersion（面板已逐字段回显）",
  );
}

/* ── 观察清单（只报告不断言） ────────────────────────────────────────────
   动态拼出来的键判定不了，死键审计误报率高，所以这一节只列出来给下一轮。 */
console.log("\n[5] 观察清单（只报告，不判定）");
{
  const auditKeys = [
    "撤销（Ctrl+Z）",
    "重做（Ctrl+Y / Ctrl+Shift+Z）",
    "复制节点（Ctrl+D）：在选中节点下方复制一个同类节点，仅复制类型、不复制内容",
    "一键居中：缩放并定位到全部节点",
    "组：把选中的节点组成一个组（快捷键 G）；选中组后再次点击解散",
    "一键排版：按连线关系整理节点位置；停在超级节点里时默认整理当前这一层；可选同时排版超级节点内部（可撤销）",
    "查找（Ctrl+F）：全局搜索画布 / 会话 / 专家团 / 素材库 / 工具库 / 技能 / 模板 / 手册文档",
    "更改当前画布名称",
    "导入画布：从 .mtnodes 文件恢复完整画布",
    "导出画布：把当前画布（含图像等资产）打包为 .mtnodes 文件，可迁移到其他电脑",
    "删除当前画布",
    "插件：云端目录更新，桌宠等按需下载",
    "工具库：打开本机已保存的工具 / 函数，插入到任意画布复用（新建这两类节点：画布空白处右键 → 工具）",
    "素材库：跨画布的本机素材仓库，按分类打包文本 / 图像 / 音频 / 视频；素材节点引用库内容，删掉画布素材仍在",
    "创意工坊：浏览 / 下载公开模板与 Skill，登录后可上传与管理自己的条目",
    "APIs/Config 全局配置：API Key 与接口地址，所有模型节点自动读取",
    "快捷键 {k}",
    "鼠标移开 1 秒后自动关闭",
    "清单格式说明（字段速查）",
    "返回 MTNode 界面（Esc 同效）",
    "上一个（Shift+Enter / ↑）",
    "下一个（Enter / ↓）",
    "关闭（Esc）",
    "写回文件（Ctrl+S）",
    "编辑并保存此文件（Ctrl+S 保存）",
  ];
  const stillUsed = auditKeys.filter((k) => JS_FILES.concat([HTML]).some((f) => f.text.indexOf(k) >= 0));
  const stillInDict = auditKeys.filter((k) => I18N.text.indexOf('"' + k + '"') >= 0);
  const dead = stillInDict.filter((k) => !stillUsed.includes(k));
  console.log(
    "  · " +
      dead.length +
      " 条已无引用的提示词条仍留在 renderer/i18n.js 字典里（本节不断言，留给后续清理）：",
  );
  for (const k of dead) console.log("      - " + k.slice(0, 68));
  console.log("  · i18n 字典键总数（粗略解析）：" + dictKeys().length + " 条");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-hint-cleanup)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-hint-cleanup)\n",
);
process.exit(fails ? 1 : 0);
