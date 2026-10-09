"use strict";
/* 询问窗「收尾总结询问」改版回归（本次开发需求）
 *   node test/smoke-ask-summary.js
 *
 * 需求（用户拷问三轮定下的口径）：询问模式下最后那张总结确认卡过于杂乱 ——
 *   整份共识塞在 question 一行里、又按纯文本渲染（`.ix-q` 没有 pre-wrap），
 *   多行被折成一坨。现在把它变成**单独一个总结格式**：
 *     · question 首行 = 一句话题面（大字纯文本），其余 = 总结区；
 *     · 总结区 = 小标题「📋 总结」+ 全站唯一入口 renderMarkdown 渲染 +
 *       限高（46vh ≈ 屏幕 40–50%）内滚 + 「复制总结 Markdown」（复制源码）；
 *     · 一律启用（只看有没有其余内容，不设长度门槛）；没有其余内容就不出总结区；
 *     · 同类卡片一起治：沙箱 / 权限审批卡的说明与理由、浏览器求助卡的正文；
 *     · 选项 label / description 支持行内 Markdown 子集（`code` / **粗体** / *斜体*）；
 *     · 契约与内置技能同步写明收尾卡的固定写法（会话 / 助手 / 开发节点 / 长任务 /
 *       工具构建四路 + mtnode-grill-me）。
 * 覆盖：
 *   [1] 渲染层接线（app-db.js 源码）
 *   [2] 真跑 ixSummarySplit（切分口径）
 *   [3] 真跑 ixInlineMd（行内子集 + 注入防护）
 *   [4] 真跑 ixSummaryBlock（结构 · 复制源码 · 剪贴板回退链）
 *   [5] 样式与词条（dsh.css / browser.css / i18n 中英成对）
 *   [6] 契约写法（技能 + 四路会话契约 + 英文词条逐字跟上）
 * 纯静态 + vm 真跑：不拉浏览器、不碰 Electron。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 46)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 源码不含 " + JSON.stringify(String(needle).slice(0, 46)));
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const I18N = read("renderer/i18n.js");
const CSS_DSH = read("renderer/css/dsh.css");
const CSS_BROWSER = read("renderer/css/browser.css");
const SKILL = read("mtnode-agent-skills/mtnode/grill-me/SKILL.md");

/* ── [1] 渲染层接线 ───────────────────────────────────────────────────────── */
console.log("\n[1] 渲染层接线（切分 · 总结区 · 同类卡片 · 选项行内）");
has(DB, "function ixSummarySplit(text) {", "新增 ixSummarySplit（题面 / 总结切分，纯函数）");
has(DB, "function ixInlineMd(text) {", "新增 ixInlineMd（选项行内 Markdown 子集）");
has(DB, "function ixEsc(text) {", "新增 ixEsc（与 app.js escapeHtml 同口径的转义兜底）");
has(DB, "function ixMdHtml(text) {", "新增 ixMdHtml（Markdown → HTML，唯一入口 + 兜底）");
has(DB, "function ixMdBlock(text, cls) {", "新增 ixMdBlock（带限高的 Markdown 区块）");
has(DB, "function ixSummaryBlock(bodyText) {", "新增 ixSummaryBlock（📋 总结区）");
has(DB, "function ixCopyText(txt, okMsg) {", "新增 ixCopyText（复制源码）");
has(
  DB,
  "if (typeof renderMarkdown === \"function\") return renderMarkdown(s);",
  "渲染走全站唯一入口 renderMarkdown（拿不到才回落纯文本）",
);
no(DB, 'md.innerHTML = String(text == null ? "" : text)', "绝不把未渲染的原文直接 innerHTML 进卡片");

/* 提问卡：首行题面 + 其余进总结区（一律启用，只看有没有内容） */
has(DB, "const qParts = ixSummarySplit(q.question);", "提问卡按 ixSummarySplit 切分 question");
has(
  DB,
  'qt.textContent = (q.header ? q.header + " · " : "") + qParts.title;',
  "首行 = 一句话题面（仍走 textContent：题面是纯文本，标题行不加富文本）",
);
has(DB, "if (qParts.body) card.appendChild(ixSummaryBlock(qParts.body));", "其余内容进总结区（没有其余内容就不出区块）");
has(DB, 'wrap.className = "ix-summary";', "总结区容器 .ix-summary");
has(DB, 'title.textContent = I18n.t("📋 总结");', "区块小标题「📋 总结」（走词条）");
has(DB, 'copy.textContent = I18n.t("复制总结 Markdown");', "动作条 = 「复制总结 Markdown」");
has(DB, "copy.onclick = () => ixCopyText(bodyText, I18n.t(\"已复制总结 Markdown\"));", "复制取渲染前的源码（不是富文本）");

/* 同类卡片：审批卡说明 / 理由 + 浏览器求助正文 */
has(DB, 'card.appendChild(ixMdBlock(detailText, "ix-approval-md"));', "沙箱 / 权限审批卡的说明与理由同源渲染");
no(DB, 'r.textContent = detailText;', "旧的纯文本 .ix-detail 写法已撤（审批说明不再挤成一行）");
has(DB, 'm.appendChild(ixMdBlock(String(d.message || ""), "ix-help-md"));', "浏览器求助卡正文同源渲染");
no(DB, 'm.textContent = String(d.message || "");', "求助正文不再走 textContent");

/* 选项文本：行内子集（题面渲染器现由提问卡与求助卡共用，见 ixRenderQuestions） */
has(DB, "txt.innerHTML = ixInlineMd(label);", "选项 label 走行内 Markdown");
has(DB, "sp.innerHTML = ixInlineMd(desc);", "选项 description 走行内 Markdown");
has(DB, "lab.title = desc;", "hover 仍是纯文本原文（不改语义）");
has(DB, "cb.value = label;", "回传值仍是原文（渲染只影响显示，不影响答案）");
has(DB, "function ixRenderQuestions(card, it, questions) {", "题面渲染器抽成一份（提问卡 / 求助卡共用）");
has(DB, "cb.dataset.qid = q.id;", "题号绑定口径不变");

/* ── [2]/[3]/[4] 真跑：抠出真源码在 vm 里跑 ─────────────────────────────── */
const FROM = DB.indexOf("function ixSummarySplit(text) {");
const TO = DB.indexOf("function renderIxPanel() {");
ok(FROM > 0 && TO > FROM, "摘到本次新增的询问卡渲染段真源码");

/* 题面渲染器还读「这题能不能多选」的判据（见 smoke-ask-multi：ixMultiOf 段就在
   ixSummarySplit 之前、求助卡题面归一那一块里）。生产里它们是同一个模块作用域，
   抠代码跑时得把这一段一并喂进上下文，否则渲染器里那行 ixMultiOf(q) 会 ReferenceError。 */
const MULTI_TO = DB.indexOf("function ixPush(kind, data, runKey, src) {");
const MULTI_FROM = DB.indexOf("const IX_MULTI_RE =");
ok(MULTI_FROM > 0 && MULTI_TO > MULTI_FROM && MULTI_TO < FROM, "摘到多选判据段（渲染器的前置依赖）");
const MULTI_SRC = DB.slice(MULTI_FROM, MULTI_TO);

/* 与 app.js 同源的 escapeHtml（真实实现，保证转义口径一致） */
const ESC = read("renderer/app.js").match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/)[0];
has(read("renderer/app.js"), ".replace(/&/g, \"&amp;\")", "escapeHtml 真源码口径：先转义 & < > \"");

let copied = null;
const toasts = [];
const mdInputs = [];
const sb = {
  console,
  navigator: {
    clipboard: {
      writeText(t) {
        copied = String(t);
        return Promise.resolve();
      },
    },
  },
  toast: (m) => toasts.push(String(m)),
  I18n: { t: (k) => String(k) },
  renderMarkdown: (s) => {
    mdInputs.push(String(s));
    return "<p>" + String(s).replace(/\n/g, "</p><p>") + "</p>";
  },
};
vm.createContext(sb);
vm.runInContext(ESC, sb);
const API = vm.runInNewContext(
  DB.slice(FROM, TO) +
    "\n;({ ixSummarySplit, ixInlineMd, ixMdHtml, ixMdBlock, ixCopyText, ixSummaryBlock })",
  sb,
);
ok(typeof API.ixSummarySplit === "function" && typeof API.ixSummaryBlock === "function", "六个纯函数取到");

console.log("\n[2] 切分口径（真源码）");
const S = (t) => API.ixSummarySplit(t);
const s1 = S("确认删除这个节点？");
ok(s1.title === "确认删除这个节点？" && s1.body === "", "单行题面 → 只有题面、没有总结区（不把题面抄第二遍）");
const s2 = S("以上共识是否无误？\n- 位置：#ixPanel\n- 切分：首行题面");
ok(s2.title === "以上共识是否无误？" && s2.body === "- 位置：#ixPanel\n- 切分：首行题面", "首行题面 + 其余成总结正文");
const s3 = S("以上共识是否无误？\n\n### 共识\n1. 切分\n2. 渲染\n\n| 项 | 值 |\n| --- | --- |\n| 限高 | 46vh |");
ok(
  s3.title === "以上共识是否无误？" && s3.body.indexOf("### 共识") === 0 && s3.body.indexOf("| 限高 | 46vh |") > 0,
  "空行 / 小标题 / 表格原样留在总结正文里（交给 renderMarkdown）",
);
const s4 = S("  题面  \r\n- a\r\n");
ok(s4.title === "题面" && s4.body === "- a", "CRLF 归一 + 首尾空白裁掉（Windows 文本不落 \r）");
const s5 = S("  \n\n 题面  \n- a");
ok(s5.title === "题面" && s5.body === "- a", "整体先 trim：题面前面的空行不算题面");
ok(S("").title === "" && S("").body === "" && S(null).body === "", "空 / null 不炸，返回空标题与空正文");
ok(S(123).title === "123", "非字符串入参按字符串处理");

console.log("\n[3] 选项行内 Markdown（真源码 + 注入防护）");
const I = (t) => API.ixInlineMd(t);
ok(I("**确认无歧义（推荐）**") === "<strong>确认无歧义（推荐）</strong>", "**粗体** 渲染成 <strong>");
ok(I("用 `ask_user_question` 问满") === "用 <code>ask_user_question</code> 问满", "反引号渲染成 <code>");
ok(I("*斜体*") === "<em>斜体</em>", "*斜体* 渲染成 <em>");
ok(I("2 * 3 * 4") === "2 * 3 * 4", "算式里的孤立星号不当斜体（星号必须紧贴内容）");
ok(I("<img src=x onerror=alert(1)>").indexOf("<img") < 0, "HTML 标签先转义 → 注入进不来");
ok(I("<img src=x onerror=alert(1)>").indexOf("&lt;img") === 0, "转义结果就是 &lt;img…（与 escapeHtml 同源）");
ok(I("a < b & c") === "a &lt; b &amp; c", "< 与 & 照 escapeHtml 口径转义");
ok(I("**a** 与 `b`") === "<strong>a</strong> 与 <code>b</code>", "粗体与行内码混排");
ok(I("") === "" && I(null) === "", "空 / null 不炸");

/* 拿不到 app.js 的 escapeHtml（被单独抠出来跑等边角）时，本地兜底仍是**转义**而非丢字符 */
console.log("\n[3b] 兜底：没有 escapeHtml / renderMarkdown 时也不放行未转义原文");
const sb3 = { console: { log: () => {}, error: () => {} }, document: { createElement: fakeEl }, I18n: { t: (k) => k } };
vm.createContext(sb3);
const API3 = vm.runInNewContext(
  DB.slice(FROM, TO) + "\n;({ ixInlineMd, ixMdHtml, ixMdBlock })",
  sb3,
);
ok(API3.ixInlineMd("<b>x</b> & y") === "&lt;b&gt;x&lt;/b&gt; &amp; y", "没有 escapeHtml → 就地做同一份转义");
ok(API3.ixInlineMd("**a**").indexOf("<strong>") === 0, "兜底路径下粗体照旧生效");
ok(API3.ixMdHtml("<b>x</b>") === "<pre>&lt;b&gt;x&lt;/b&gt;</pre>", "没有 renderMarkdown → <pre> + 转义纯文本");

console.log("\n[4] 总结区结构 · 复制源码（真源码 + 假 DOM）");
function fakeEl(tag) {
  const el = {
    tag: tag,
    className: "",
    textContent: "",
    type: "",
    title: "",
    onclick: null,
    children: [],
    innerHTML: "",
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  return el;
}
sb.document = { createElement: fakeEl };
const el = API.ixSummaryBlock("- 位置：#ixPanel\n- 渲染：renderMarkdown");
ok(el.className === "ix-summary", "外层 = .ix-summary");
const head = el.children[0];
ok(head && head.className === "ix-summary-head", "第一块 = 头部 .ix-summary-head");
ok(head.children[0].className === "ix-summary-title" && head.children[0].textContent === "📋 总结", "头部第一项 = 小标题「📋 总结」");
const btn = head.children[1];
ok(btn && btn.className === "mini ix-summary-copy" && btn.textContent === "复制总结 Markdown", "头部第二项 = 「复制总结 Markdown」按钮");
ok(btn.type === "button", "按钮 type=button（不会被当提交键）");
const md = el.children[1];
ok(md && md.className === "md ix-md-block ix-summary-md", "第二块 = .md.ix-md-block.ix-summary-md（排版归全站 .md）");
ok(md.innerHTML.indexOf("- 位置：#ixPanel") >= 0, "正文由 renderMarkdown 渲染（不是原文直塞）");
ok(mdInputs[mdInputs.length - 1] === "- 位置：#ixPanel\n- 渲染：renderMarkdown", "交给 renderMarkdown 的是**渲染前源码**（一字不改）");
copied = null;
btn.onclick();
ok(copied === "- 位置：#ixPanel\n- 渲染：renderMarkdown", "点「复制」写进剪贴板的也是渲染前源码（可贴去别处）");
ok(API.ixMdBlock("x", "ix-approval-md").className === "md ix-md-block ix-approval-md", "ixMdBlock 支持附加类名（审批卡 / 求助卡共用）");
ok(API.ixMdBlock("").innerHTML === "<p></p>", "空正文也渲染成空块（不抛错）");

/* 剪贴板回退链：优先会话那套 dshClipboardWrite，拿不到才退原生 */
has(DB, 'if (typeof dshClipboardWrite === "function") {', "复制优先走会话共用的 dshClipboardWrite");
has(DB, "if (navigator.clipboard && navigator.clipboard.writeText) {", "回退到原生 navigator.clipboard.writeText");
has(DB, "} catch (_) {}", "两条都失败只当没复制（不抛错、不弹错）");

/* 渲染失败兜底：renderMarkdown 抛错 → 转义纯文本，绝不白屏 */
console.log("\n[4b] 兜底：渲染入口抛错时回落转义纯文本");
const sb2 = Object.assign({}, sb, {
  console: { log: () => {}, error: () => {} },
  renderMarkdown: () => {
    throw new Error("boom");
  },
  document: { createElement: fakeEl },
});
vm.createContext(sb2);
const API2 = vm.runInNewContext(
  DB.slice(FROM, TO) + "\n;({ ixMdHtml, ixMdBlock })",
  sb2,
);
const boom = API2.ixMdBlock("<b>x</b> & y");
ok(
  boom.innerHTML.indexOf("<b>x</b>") < 0 &&
    boom.innerHTML.indexOf("<pre>") === 0 &&
    boom.innerHTML.indexOf("&lt;b&gt;") > 0 &&
    boom.innerHTML.indexOf("&amp; y") > 0,
  "抛错 → <pre> + 转义纯文本（不白屏、不注入）",
);

/* ── [4c] 真跑 renderIxPanel：整卡渲染出来的就是「题面 + 📋 总结区 + 选项」 ── */
console.log("\n[4c] 真跑 renderIxPanel（假 DOM · 收尾确认卡 vs 普通短问题）");
const TO_PANEL_END = DB.indexOf("/* ── 主题(dsh = 默认");
const FROM_PANEL = DB.indexOf("function ixLaterButton(it) {");
ok(TO_PANEL_END > TO && FROM_PANEL > 0 && FROM_PANEL < FROM, "摘到 renderIxPanel 收尾边界 + 按钮函数起点（主题段之前）");
function mkDom() {
  const doc = {
    body: null,
    createElement(tag) {
      return {
        tag,
        id: "",
        className: "",
        textContent: "",
        innerHTML: "",
        type: "",
        title: "",
        placeholder: "",
        value: "",
        dataset: {},
        style: {},
        children: [],
        onclick: null,
        addEventListener() {},
        classList: { add() {}, remove() {}, contains: () => false },
        appendChild(c) {
          this.children.push(c);
          return c;
        },
        remove() {},
      };
    },
    getElementById: () => null,
  };
  doc.body = doc.createElement("body");
  return doc;
}
function allByClass(el, cls, out) {
  out = out || [];
  if (!el) return out;
  if (String(el.className || "").split(/\s+/).indexOf(cls) >= 0) out.push(el);
  for (const c of el.children || []) allByClass(c, cls, out);
  return out;
}
function renderCard(questionText) {
  const doc = mkDom();
  const c = {
    console: { log: () => {}, error: () => {} },
    document: doc,
    S: {
      activeIx: {
        items: [
          {
            kind: "question",
            runKey: "",
            data: {
              id: "card1",
              questions: [
                {
                  id: "q1",
                  question: questionText,
                  options: [{ label: "**确认无歧义，开始实施（推荐）**", description: "`grill` 收尾" }],
                },
              ],
            },
          },
        ],
      },
    },
    I18n: { t: (k) => String(k) },
    /* app-db.js 的模块级状态位（在本次抠出的片段之外声明）→ 当成上下文全局喂进来 */
    ixFreshCard: false,
    ixFreshPulse: false,
    $: () => null,
    ixPruneAllInteraction: () => {},
    ixMakeDraggable: () => {},
    ixRestorePos: () => {},
    renderMarkdown: (s) => "<p>" + String(s).replace(/\n/g, "</p><p>") + "</p>",
    toast: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  const ctx = vm.createContext(c);
  vm.runInContext(ESC, ctx);
  vm.runInContext(MULTI_SRC, ctx);
  vm.runInContext(DB.slice(FROM_PANEL, TO_PANEL_END) + "\n;renderIxPanel();", ctx);
  return doc;
}
const longQ =
  "以上共识是否无误？\n\n### 共识\n- 切分：首行题面\n- 渲染：renderMarkdown\n\n| 项 | 值 |\n| --- | --- |\n| 限高 | 46vh |";
const domLong = renderCard(longQ);
ok(!!allByClass(domLong.body, "ix-card")[0], "收尾确认卡渲染出来了");
const qEl = allByClass(domLong.body, "ix-q")[0];
ok(qEl && qEl.textContent === "以上共识是否无误？", "题面 = 首行那一句（大字，不含总结正文）");
ok(allByClass(domLong.body, "ix-summary").length === 1, "整卡只出一块 📋 总结区（不重复、不拆卡）");
const sumTitle = allByClass(domLong.body, "ix-summary-title")[0];
ok(sumTitle && sumTitle.textContent === "📋 总结", "总结区带小标题");
const sumBtn = allByClass(domLong.body, "ix-summary-copy")[0];
ok(sumBtn && sumBtn.textContent === "复制总结 Markdown", "总结区带「复制总结 Markdown」");
const mdEls = allByClass(domLong.body, "ix-summary-md");
ok(
  mdEls.length === 1 && mdEls[0].innerHTML.indexOf("### 共识") > 0 && mdEls[0].innerHTML.indexOf("| 限高 | 46vh |") > 0,
  "总结正文 = 空行之后的原文交给 renderMarkdown（小标题与表格都进渲染）",
);
const labelEl = allByClass(domLong.body, "ix-opt-label")[0];
ok(
  labelEl && labelEl.innerHTML.indexOf("<strong>确认无歧义，开始实施（推荐）</strong>") === 0,
  "选项 label 的 **粗体** 已渲染（星号不外露）",
);
ok(
  allByClass(domLong.body, "ix-opt-desc")[0].innerHTML === "<code>grill</code> 收尾",
  "选项 description 的反引号已渲染成行内码",
);
const optInputs = allByClass(domLong.body, "ix-opt")[0].children.filter((x) => x.tag === "input");
ok(optInputs.length === 1 && optInputs[0].value === "**确认无歧义，开始实施（推荐）**", "回传值仍是**原文**（渲染只影响显示）");
const domShort = renderCard("确认删除这个节点？");
ok(allByClass(domShort.body, "ix-summary").length === 0, "单行短问题不出总结区（不把题面抄第二遍）");
ok(allByClass(domShort.body, "ix-q")[0].textContent === "确认删除这个节点？", "短问题照旧只有题面一行");

/* ── [5] 样式与词条 ───────────────────────────────────────────────────────── */
console.log("\n[5] 样式与词条");
const rule = (css, sel) => {
  const i = css.indexOf(sel + " {");
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i) + 1);
};
const sum = rule(CSS_DSH, ".ix-summary");
ok(!!sum, "dsh.css 定义 .ix-summary");
ok(/border-left:\s*3px solid var\(--cyan\)/.test(sum), "总结区左侧竖条（与提问卡同一套青色标识）");
ok(/background:/.test(sum), "总结区有浅底（与卡片其余部分区分）");
const titleRule = rule(CSS_DSH, ".ix-summary-title");
ok(!!titleRule && /color:\s*var\(--cyan2\)/.test(titleRule), ".ix-summary-title 取主题色（浅色主题自适应）");
ok(!!rule(CSS_DSH, ".ix-summary-copy"), ".ix-summary-copy 有独立规则（不参与标题省略号挤压）");
const mdRule = rule(CSS_DSH, ".ix-md-block");
ok(!!mdRule, "dsh.css 定义 .ix-md-block");
ok(/max-height:\s*46vh/.test(mdRule), "限高 46vh ≈ 屏幕 40–50%（口径写在注释里）");
ok(/overflow:\s*auto/.test(mdRule), "超出部分区块内部滚动");
ok(!!rule(CSS_DSH, ".ix-approval-md"), ".ix-approval-md 有样式（审批说明用同一套渲染）");
ok(!!CSS_BROWSER.match(/\.ix-card \.ix-help-msg \.ix-help-md\s*\{/), "browser.css 给求助卡里层 .ix-help-md 留了规则");
ok(/white-space:\s*normal/.test(read("renderer/css/canvas.css").match(/\.md \{[\s\S]*?\n\}/)[0]), "全站 .md 自己归位 white-space: normal（容器 pre-wrap 不会污染块级排版）");

const hasEnEntry = (key) => {
  const i = I18N.indexOf(JSON.stringify(key) + ":");
  if (i < 0) return false;
  const tail = I18N.slice(i, i + 400);
  const m = tail.match(/["']([^"'\n]{2,})["']/g);
  if (!m) return false;
  return m.some((s) => /[A-Za-z]{3}/.test(s));
};
for (const key of [
  "📋 总结",
  "复制总结 Markdown",
  "把这一段总结的 Markdown 原文（渲染前的源码）复制到剪贴板",
  "已复制总结 Markdown",
]) {
  ok(hasEnEntry(key), "i18n 有词条（含英文值）：" + key.slice(0, 30));
}

/* ── [6] 契约写法：技能 + 四路会话契约 ───────────────────────────────────── */
console.log("\n[6] 契约写法（技能 · 四路契约 · 英文逐字跟上）");
has(SKILL, "📋 总结", "技能 mtnode-grill-me 写明收尾卡会渲染进「📋 总结」区");
has(SKILL, "第一行只放一句话题面", "技能写明题面只占第一行");
has(SKILL, "空行之后", "技能写明总结放在空行之后");
has(ASSIST, "收尾那张确认卡按固定格式写", "会话 / 助手的 GRILL_CONTRACT 带上收尾卡写法");
has(ASSIST, "卡片会把这一段渲染进「📋 总结」区", "契约点明渲染去处（与渲染层同源）");
has(APP, "收尾那张确认卡按固定格式写", "开发节点任务书那段【拷问模式】同步");
has(read("renderer/app-longtask-guide.js"), "收尾那张确认卡（最后一次询问窗）按固定格式写", "长周期任务新建引导同步");
has(read("renderer/app-longtask-edit.js"), "收尾那张确认卡（最后一次询问窗）按固定格式写", "长周期任务编辑引导同步");
has(read("renderer/app-toolbuild.js"), "收尾那张确认卡按固定格式写", "工具构建任务书同步");

/* 英文词条逐字跟上：改了契约键就必须同步英文值，否则英文界面退回中文 */
const GRILL_RE = /const GRILL_CONTRACT =\n([\s\S]*?);\n/;
const gm = ASSIST.match(GRILL_RE);
ok(!!gm, "抠到 GRILL_CONTRACT 常量");
let grillContract = "";
try {
  grillContract = vm.runInNewContext("(" + gm[1] + ")");
} catch (e) {
  ok(false, "GRILL_CONTRACT 可求值：" + e.message);
}
ok(grillContract.indexOf("📋 总结") > 0, "契约正文含收尾卡写法（真值求出来看，不是靠源码字符串猜）");
const I18nMod = require(path.join(ROOT, "renderer", "i18n.js"));
I18nMod.setLocale("en");
const enGrill = I18nMod.t(grillContract);
const enTaskbook = I18nMod.t(
  APP.match(/I18n\.t\(\n\s*"(\【拷问模式·本轮先问不做\】[\s\S]*?)",\n\s*\),/)[1],
);
I18nMod.setLocale("zh");
ok(enGrill !== grillContract, "GRILL_CONTRACT 整段有英文词条（键逐字一致才有这条）");
ok(
  enGrill.indexOf("Any ambiguity left in the consensus above?") > 0,
  "英文值同步写进收尾卡写法（英文界面不回退中文）",
);
ok(enTaskbook !== "" && enTaskbook.indexOf("【拷问模式·本轮先问不做】") < 0, "开发节点任务书那段的英文词条也在位");
ok(
  enTaskbook.indexOf("Any ambiguity left in the consensus above?") > 0,
  "任务书英文段同样写明收尾卡写法",
);

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-ask-summary)",
);
process.exit(fails ? 1 : 0);
