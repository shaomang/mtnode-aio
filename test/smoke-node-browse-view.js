"use strict";
/* 节点「浏览态（未选中）× 只读文本视图」回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-node-browse-view.js
 * 要保住的行为：文本 / 图像相关节点**只有被选中时才是可编辑形态**；未选中时像超级节点那样
 * 直接显示内容（Markdown / YAML 正确渲染、图像铺满），除节点头部那排小按钮以外没有任何交互。
 * 覆盖：
 *   [1] 形态判定骨架：kind 集合、判定口径、save 旧别名归一、buildBody 入口分流与失败回落
 *   [2] 七个 kind 的浏览态渲染器登记齐全；浏览态分支不构造任何输入控件、不挂点击事件
 *   [3] 编辑态零回归：buildBody 后半段照旧有 textarea / 输出按钮 / 拖宽条
 *   [4] 选中三路径形态同步：.n-resize 快速路径走 setNodeSelClass；改状态不重绘处补 syncNodeForms
 *   [5] 点选即聚焦：markFormFocusAfterRender → renderCanvas 收尾 applyFocusFormAfterRender 接线
 *   [6] CSS：.wf-node.browse 收紧内边距（且左右仍躲开接线排）+ 只读视图/条目/裸图规则齐全
 *   [7] index.html 脚本顺序：app.js → app-nodeview.js → app-canvas.js
 *   [8] detectViewLang 判定样例（vm 加载纯逻辑）
 *   [9] nodeTextViewEl 三语言渲染 + YAML 无行号 + @引用着色不破坏 HTML */
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
/* 读源码并统一换行（CSS 在 Windows 工作区里常是 CRLF，锚点串按 \n 写就好） */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

const jsCanvas = read("renderer/app-canvas.js");
const jsApp = read("renderer/app.js");
const jsView = read("renderer/app-nodeview.js");
const html = read("renderer/index.html");
const css = read("renderer/css/canvas.css");
const cssLight = read("renderer/css/theme-light.css");

function blockFrom(src, anchorIndex) {
  if (anchorIndex < 0) return null;
  const open = src.indexOf("{", anchorIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(open, i + 1);
    }
  }
  return null;
}
/* 从 from 锚点之后、到 to 锚点之前（用于把「浏览态区块」与「编辑态 buildBody」切开） */
function sliceBetween(src, fromAnchor, toAnchor) {
  const a = src.indexOf(fromAnchor);
  const b = src.indexOf(toAnchor);
  if (a < 0 || b < 0 || b <= a) return null;
  return src.slice(a, b);
}
const funcBody = (src, sig) => blockFrom(src, src.indexOf(sig));

/* 浏览态区块（登记表）与编辑态区块：以 function buildBody 为界 */
const BROWSE_MARK = "/* ============ 浏览态 body 渲染器（NODE_BROWSE_BODY 登记表） ============";
const browseRegion = sliceBetween(jsCanvas, BROWSE_MARK, "function buildBody(node, body) {");
const editRegion = jsCanvas.slice(jsCanvas.indexOf("function buildBody(node, body) {"));

const KINDS = [
  "input_text",
  "input_image",
  "proc_text",
  "proc_image",
  "agent_task",
  "chat",
  "save",
];

console.log("\n[1] 形态判定骨架：kind 集合与判定口径");
{
  const m = jsCanvas.match(/const NODE_BROWSE_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  ok(!!m, "app-canvas.js 声明了 NODE_BROWSE_KINDS 集合");
  const setSrc = m ? m[1] : "";
  for (const k of KINDS) ok(setSrc.includes('"' + k + '"'), "集合含 " + k + "（参与「未选中 = 浏览态」）");
  for (const k of ["super", "task", "judge", "control", "timer", "music_gen", "video_gen", "remotion", "net_recv", "net_send", "db_table", "input_file", "execute"])
    ok(!setSrc.includes('"' + k + '"'), k + " 不参与（控制流 / 超级 / 开发 / 媒体 / 网络恒为编辑形态）");
  ok(/function nodeBrowseKind\(n\) \{[\s\S]{0,120}?NODE_BROWSE_KINDS\.has\(nodeBrowseKindKey\(n\)\)/.test(jsCanvas), "nodeBrowseKind 只按 kind 集合判定");

  const mode = funcBody(jsCanvas, "function nodeBrowseMode(n)");
  ok(!!mode && mode.includes("if (!nodeBrowseKind(n)) return false;"), "不参与集合的 kind 直接返回 false（永不进浏览态）");
  ok(!!mode && mode.includes("return !nodeSelState(n);"), "判定口径 = 未选中（nodeBrowseMode(n) = !nodeSelState(n)）");
  const sel = funcBody(jsCanvas, "function nodeSelState(n)");
  ok(!!sel && sel.includes("isSel(n.id)") && sel.includes("S.sel === n.id"), "选中语义同时认 S.selSet（多选）与 S.sel（主选中）");

  const key = funcBody(jsCanvas, "function nodeBrowseKindKey(n)");
  ok(!!key && key.includes("isSaveKind(n.kind)") && key.includes('return "save"'), "save_text / save_image 旧别名归一到 save（共用一个渲染器）");

  const at = jsCanvas.indexOf("function buildBody(node, body) {");
  ok(at > 0, "buildBody 存在");
  ok(jsCanvas.slice(at, at + 260).includes("if (nodeBrowseMode(node) && buildBrowseBody(node, body)) return;"), "buildBody 入口第一句就是形态分流（编辑态代码在其后、零改动）");
  const bb = funcBody(jsCanvas, "function buildBrowseBody(node, body)");
  ok(!!bb && bb.includes("NODE_BROWSE_BODY[nodeBrowseKindKey(node)]"), "按 kind 键查浏览态渲染器");
  ok(!!bb && /typeof fn !== "function"\) return false/.test(bb), "未登记该 kind → 返回 false → 回落编辑态（不留白屏）");
  ok(!!bb && /catch/.test(bb) && bb.includes('while (body.firstChild) body.removeChild(body.firstChild);'), "handler 抛错也清空 body 再回落（不留半渲染）");
  /* const 表与 handler 登记必须早于 buildBody 的运行时使用 */
  ok(jsCanvas.indexOf("const NODE_BROWSE_KINDS") < at && jsCanvas.indexOf(BROWSE_MARK) < at, "kind 集合与浏览态区块都写在 buildBody 之前");
}

console.log("\n[2] 七个 kind 的浏览态渲染器登记齐全 + 浏览态零交互构件");
{
  for (const k of KINDS)
    ok(new RegExp("NODE_BROWSE_BODY\\." + k + "\\s*=").test(jsCanvas), "登记了 NODE_BROWSE_BODY." + k);
  const declared = [...jsCanvas.matchAll(/NODE_BROWSE_BODY\.(\w+)\s*=/g)].map((x) => x[1]);
  const uniq = [...new Set(declared)].sort().join(",");
  ok(uniq === [...KINDS].sort().join(","), "登记表键集 = kind 集合（多登记=白渲染，少登记=回落）：实测 " + uniq);
  ok(!!browseRegion, "能按注释锚点切出「浏览态 body 渲染器」区块");
  if (browseRegion) {
    ok(!/createElement\("textarea"\)/.test(browseRegion), "浏览态区块不构造 textarea（不再有输入框）");
    ok(!/createElement\("input"\)/.test(browseRegion), "浏览态区块不构造 input（含 checkbox / 路径框）");
    ok(!/createElement\("button"\)/.test(browseRegion), "浏览态区块不构造 button（复制 / 清空 / 浏览 / 选择图像等都不渲染）");
    ok(!/\.onclick\s*=/.test(browseRegion), '浏览态区块不挂 onclick（"点空白换图"那类已撤掉）');
    ok(!/addEventListener\("click"/.test(browseRegion), '浏览态区块不挂 click 监听（只留展示与滚动）');
    ok(!/class(Name)?\s*=\s*["'](n-text|n-bentries|n-out-btns|n-out-resize)["']/.test(browseRegion), "浏览态区块不复用编辑态控件类名");
    for (const id of ["st-", "dsh-out-stream-", "dsh-out-tools-", "chat-stream-", "chat-think-", "out-img-", "outimg-", "svpre-", "svimg-", "svempty-"])
      ok(browseRegion.includes('"' + id + '" + node.id'), "浏览态沿用同一个回填 id（运行中的流式增量 / fillPreviews 照常命中）：\"" + id + '" + node.id');
    ok(/\.id = "st-" \+ node\.id/.test(browseRegion), "status 行 id 与编辑态完全一致");
    ok(browseRegion.includes("n-img bare"), "图像走 .n-img.bare（铺满、无虚线框）");
    ok(browseRegion.includes("n-view-entries"), "批量 / YAML 条目走紧凑条目列表（替掉那一排 textarea）");
  }
}
console.log("\n[3] 编辑态零回归（只有新增，没有删改）");
{
  ok(!!editRegion, "能切出编辑态区块（buildBody 起）");
  ok(/const ta = document.createElement\("textarea"\);/.test(editRegion), "编辑态仍构造 textarea（选中后与今天完全一致）");
  ok(/className = "n-out-btns"/.test(editRegion), "编辑态仍有输出面板按钮组（复制 / 清空 / 浏览）");
  ok(/className = "n-out-resize"/.test(editRegion), "编辑态仍有输出面板左缘拖宽条");
  ok(/className = "n-bentries"|n-bentries/.test(editRegion), "编辑态仍有批量条目编辑列表");
  ok(!jsCanvas.slice(0, jsCanvas.indexOf(BROWSE_MARK)).match(/function browseTextEl\(/), "浏览态 helper 都只在新增区块里定义（不侵入既有函数）");
}

console.log("\n[4] 选中三路径形态同步");
{
  const rzAt = jsCanvas.indexOf('rz.className = "n-resize";');
  ok(rzAt > 0, "存在 .n-resize 拖拽把手（节点尺寸调整快速路径）");
  const rzBlock = blockFrom(jsCanvas, jsCanvas.indexOf('rz.addEventListener("mousedown"', rzAt));
  ok(!!rzBlock && rzBlock.includes("setNodeSelClass(hostEl, node, true)"), ".n-resize 的 mousedown 走统一 helper（不再裸改 class）");
  ok(!!rzBlock && !/classList\.add\("sel"\)/.test(rzBlock), ".n-resize 里不再出现裸 classList.add(\"sel\")");
  ok(!jsCanvas.includes('.classList.add("sel")'), "app-canvas.js 全文件没有裸加 .sel 的写法（改形态只有一条路）");
  const helper = funcBody(jsCanvas, "function setNodeSelClass(el, node, on)");
  ok(!!helper && helper.includes('.classList.toggle("sel", !!on)') && helper.includes("applyNodeForm(host, node)"), "setNodeSelClass：sel class 与浏览 / 编辑形态一起切");
  ok(!!helper && helper.includes('.classList.remove("sel")') && helper.includes("applyNodeForm(x, nodeById(x.dataset.nid))"), "被撤选的其它节点同时换回各自形态");
  const apply = funcBody(jsCanvas, "function applyNodeForm(el, node)");
  ok(!!apply && apply.includes('.classList.toggle("browse", browse)') && apply.includes("el.dataset.nodeForm = form"), "applyNodeForm 同时写 .browse 类与 dataset.nodeForm");
  ok(!!apply && apply.includes("if (el.dataset.nodeForm === form) return;"), "形态真变了才重建 body（不打断正在进行的输入）");
  const rebuild = funcBody(jsCanvas, "function rebuildNodeBody(node, bodyEl)");
  ok(!!rebuild && rebuild.includes("buildBody(node, bodyEl)") && rebuild.includes("refreshPorts(el, node)"), "rebuildNodeBody 只重建 .n-body 并同步端子（保留头部 / .n-resize）");
  const bodyOf = funcBody(jsCanvas, "function nodeBodyEl(el)");
  ok(!!bodyOf && bodyOf.includes('":scope > .n-body"'), "只取本节点直属 body（不误伤超级节点内的子节点）");
  const nEl = jsCanvas.indexOf("el.className = \"wf-node \" + kindCls");
  ok(nEl > 0 && jsCanvas.slice(nEl, nEl + 400).includes('el.classList.add("browse")'), "nodeElement 初绘即打 .browse");
  ok(nEl > 0 && jsCanvas.slice(nEl, nEl + 400).includes("el.dataset.nodeForm = _browse ? \"browse\" : \"edit\""), "nodeElement 初绘即记形态");
  const sync = funcBody(jsCanvas, "function syncNodeForms()");
  ok(!!sync && sync.includes("if (!nodeSelState(n)) x.classList.remove(\"sel\")") && sync.includes("applyNodeForm(x, n)"), "syncNodeForms 兜底：没有选中就不可能是编辑态");
  const syncCalls = (jsCanvas.match(/syncNodeForms\(\);/g) || []).length;
  ok(syncCalls >= 2, "改选择状态但不重绘的暗路径都补了 syncNodeForms()（实测 " + syncCalls + " 处调用）");
  ok(/soft\) \{\n\s*syncMarkSelDom\(\);[\s\S]{0,160}?syncNodeForms\(\);/.test(jsCanvas), "selectMark(soft) 撤节点选中后同步形态");
  ok(/S\.selSet\.clear\(\);\n\s*S\.selGroup = null;[\s\S]{0,120}?syncNodeForms\(\);/.test(jsCanvas), "startMarkDrag 撤节点选中后同步形态");
}

console.log("\n[5] 点选浏览态节点 → 光标落到主输入框末尾");
{
  const mark = funcBody(jsCanvas, "function markFormFocusAfterRender(node)");
  ok(!!mark && mark.includes("if (!nodeBrowseKind(node)) return;") && mark.includes("S._focusFormAfterRender = node.id;"), "只在参与浏览的 kind 上许下聚焦，并把意图写进 S._focusFormAfterRender");
  const applyAt = funcBody(jsCanvas, "function applyFocusFormAfterRender()");
  ok(!!applyAt && applyAt.includes("S._focusFormAfterRender = null;"), "收尾先清意图（不重复抢焦点）");
  ok(!!applyAt && applyAt.includes("if (!node || nodeBrowseMode(node)) return;"), "兑现时再确认已在编辑态（撤销选中就不聚焦）");
  ok(!!applyAt && /inp\.focus\(\{ preventScroll: true \}\)/.test(applyAt) && /setSelectionRange\(end, end\)/.test(applyAt), "focus + 光标移到文本末尾，且不引起页面跳动");
  const main = funcBody(jsCanvas, "function nodeMainInputEl(el)");
  ok(!!main && main.includes("textarea.n-text:not([readonly])"), "主输入框优先 textarea.n-text（只读框不当焦点目标）");
  ok(/renderTaskCrumb\(\);\n\s*\/\*[\s\S]{0,80}?\n\s*applyFocusFormAfterRender\(\);/.test(jsCanvas), "renderCanvas 收尾（renderTaskCrumb 之后）兑现聚焦");
  ok(jsApp.includes("const wasBrowse = nodeBrowseMode(node);"), "startNodeDrag 在改选择状态前记下「点击前是浏览态」");
  const fb = (jsApp.match(/if \(wasBrowse\) markFormFocusAfterRender\(node\);/g) || []).length;
  ok(fb === 2, "两个「首次点选」分支都补了聚焦意图（多选 + 单选；实测 " + fb + " 处）");
  ok(jsApp.includes('const wasBrowse = nodeBrowseMode(node);') && jsApp.indexOf("wasBrowse") < jsApp.indexOf("S.selSet = new Set([node.id]);", jsApp.indexOf("function startNodeDrag")), "记录早于状态变更（否则判定永远为 false）");
}

console.log("\n[6] 浏览态样式：收紧内边距 + 只读视图 + 裸图 + 亮色主题");
{
  /* 锚点带换行：避免命中 .wf-node.super…>.n-body { 这类复合选择器 */
  const base = ruleBlock(css, "\n.n-body {");
  const browse = ruleBlock(css, ".wf-node.browse>.n-body {");
  ok(!!base && !!browse, "canvas.css 里 .n-body 与 .wf-node.browse>.n-body 两条规则都在");
  const bp = padding(base), pr = padding(browse);
  ok(!!bp && !!pr, "两条规则都声明了 padding");
  if (bp && pr) {
    ok(pr.v < bp.v && pr.h < bp.h, "浏览态内边距更紧（上下 " + bp.v + "→" + pr.v + "px，左右 " + bp.h + "→" + pr.h + "px）");
    ok(pr.h >= 16, "左右仍留 " + pr.h + "px，躲开 .wf-node::before/::after 的接线排（没有真的贴到 0）");
  }
  for (const cls of ["n-view", "n-view-plain", "n-view-md", "n-view-yaml", "n-view-entries", "n-view-entry", "n-view-entry-title", "n-view-entry-body", "n-view-empty"])
    ok(css.includes(".wf-node.browse ." + cls), "CSS 覆盖 ." + cls + "（与 app-canvas.js 约定类名一致）");
  ok(css.includes(".wf-node.browse .n-img.bare"), "CSS 有 .n-img.bare（去虚线框 / 去内边距）");
  const view = ruleBlock(css, ".wf-node.browse .n-view {");
  ok(!!view && /border:\s*none/.test(view) && /background:\s*none/.test(view), "只读视图去边框去底色，与板身一体化");
  ok(!!view && /font-size:\s*13px/.test(view) && /line-height:\s*1\.6/.test(view), "浏览态字号 13px / 行高 1.6（比编辑态更好读）");
  ok(!!view && /overflow-y:\s*auto/.test(view), "超高内容在 .n-view 一层滚动（节点高度仍由用户拖拽决定）");
  const bareImg = ruleBlock(css, ".wf-node.browse .n-img.bare img {");
  ok(!!bareImg && /object-fit:\s*contain/.test(bareImg) && /width:\s*100%/.test(bareImg), "图像铺满 body 且保比例");
  const yml = ruleBlock(css, ".wf-node.browse .n-view-yaml {");
  ok(!!yml && yml.includes("var(--mono)"), "YAML 用等宽字体");
  ok(!!yml && /white-space:\s*pre/.test(yml), "YAML 保留缩进（不被压成一行）");
  ok(!/line-number|data-ln|\.n-view-yaml \.ln\b/.test(css), "浏览态 YAML 没有任何行号样式");
  ok(/\.md h1/.test(css) && /font-size:\s*15px/.test(ruleBlock(css, ".wf-node.browse .md h1 {") || ""), "节点内 Markdown 标题被压缩排版（h1 = 15px）");
  const lightCount = (cssLight.match(/body\.theme-light \.wf-node\.browse/g) || []).length;
  ok(lightCount >= 3, "亮色主题为浏览态补了色值（实测 " + lightCount + " 条 .wf-node.browse 覆盖）");
}
function ruleBlock(src, selector) {
  const at = src.indexOf(selector);
  return at < 0 ? null : blockFrom(src, at);
}
function padding(block) {
  const m = block && block.match(/padding:\s*(\d+)px\s+(\d+)px/);
  return m ? { v: +m[1], h: +m[2] } : null;
}

console.log("\n[7] 脚本加载顺序（= 模块分层）");
{
  const iApp = html.indexOf('<script src="app.js">');
  const iView = html.indexOf('<script src="app-nodeview.js">');
  const iCanvas = html.indexOf('<script src="app-canvas.js">');
  ok(iApp > 0 && iView > 0 && iCanvas > 0, "三个脚本都在 index.html 里");
  ok(iApp < iView && iView < iCanvas, "顺序为 app.js → app-nodeview.js → app-canvas.js（nodeview 依赖 app.js，app-canvas 依赖 nodeview）");
  for (const fn of ["function detectViewLang(", "function nodeTextViewEl(", "function highlightAtRefsHtml("])
    ok(jsView.includes(fn), "app-nodeview.js 导出 " + fn.replace("function ", "").replace("(", "") + "（全局函数，与其它 app-*.js 同风格）");
  ok(!/\brequire\(|\bmodule\.exports|^import /m.test(jsView), "app-nodeview.js 是普通浏览器脚本（无 require / module / import）");
}

/* ============ [8][9] vm 加载 app-nodeview.js 跑纯逻辑 ============ */
function loadNodeView() {
  const made = [];
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: "",
      dataset: {},
      style: {},
      children: [],
      textContent: "",
      innerHTML: "",
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    };
    el.classList = {
      add(c) {
        if (!(" " + el.className + " ").includes(" " + c + " "))
          el.className = (el.className + " " + c).trim();
      },
    };
    made.push(el);
    return el;
  }
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const sandbox = {
    document: { createElement: makeEl },
    I18n: { t: (k) => "《" + k + "》" },
    escapeHtml: esc,
    /* 真 highlightYamlLine 会把 key 包成 <span class="yaml-k">；桩只要可辨识 */
    highlightYamlLine: (line) => {
      const s = esc(line);
      return s.replace(/^(\s*-?\s*)([A-Za-z_][\w.-]*)(:)/, '$1<span class="yaml-k">$2</span>$3');
    },
    renderMarkdown: (t) =>
      esc(String(t)).replace(/^# (.+)$/m, "<h1>$1</h1>").replace(/\n/g, "") || "<p></p>",
    /* @引用判定的四个上游依赖：画布上有个标题 Alpha 与标签 秋 */
    refCandidates: () => [{ title: "Alpha" }],
    refTagCandidates: () => ["秋"],
    findCandidateByTitle: (cands, tok) => (cands || []).find((c) => c.title === tok) || null,
    tagByAtToken: (tok) => String(tok || ""),
    console,
  };
  const probe =
    jsView +
    "\n;globalThis.__probe = { detectViewLang, analyzeTextView, nodeTextViewEl, highlightAtRefsHtml, nodeViewIsEmpty };";
  vm.runInNewContext(probe, sandbox, { filename: "renderer/app-nodeview.js" });
  return sandbox.__probe;
}
/* 把 DOM 桩展平成可断言的字符串 / 结构 */
function flat(el) {
  return {
    cls: el.className,
    lang: el.dataset.viewLang,
    html: el.innerHTML,
    text: el.textContent,
    kids: el.children.map(flat),
  };
}
function allHtml(n) {
  return (n.html || "") + n.kids.map(allHtml).join("");
}
function allText(n) {
  return (n.text || "") + n.kids.map(allText).join("");
}

console.log("\n[8] detectViewLang：保守判定（yaml / md / plain）");
{
  const nv = loadNodeView();
  const cases = [
    ["普通中文提示词（两行无冒号）", "把这段文案改写得更口语化。\n保留专有名词，不要添加解释。", "plain"],
    ["单行含全角冒号", "把这句话改得更口语：谢谢观看", "plain"],
    ["散文里出现 --- 分隔", "第一段讲世界观。\n---\n第二段讲人物动机。", "plain"],
    ["短 a: b 不误判成 md", "a: b", "plain"],
    ["单行 title: hello 不算 yaml", "title: hello", "plain"],
    ["YAML 文档头 + 列表", "---\n- id: p1\n  name: 苹果\n- id: p2\n  name: 橙子\n", "yaml"],
    ["YAML 注释 + 列表（# 不当标题）", "# 商品表\n- id: p1\n  name: 苹果\n- id: p2\n  name: 橙子\n", "yaml"],
    ["YAML 块标量 key: |", "prompt: |\n  写一句广告语\n  保持简洁\n", "yaml"],
    ["成规模 key: value", "provider: mtnode\nmodel: deepseek-chat\ntemperature: 0.7\n", "yaml"],
    ["Markdown 标题", "# 角色设定\n你是一个口语化改写助手。", "md"],
    ["Markdown 围栏", "```\nfoo: bar\n```\n", "md"],
    ["Markdown 表格", "| 名称 | 价格 |\n|---|---|\n| 苹果 | 6 |\n", "md"],
    ["Markdown 链接", "详见 [节点指南](guides/nodes/input_text.md)。", "md"],
  ];
  for (const [label, text, want] of cases) {
    const got = nv.detectViewLang(text);
    ok(got === want, label + " → " + want + "（实测 " + got + "）");
  }
  ok(nv.detectViewLang("") === "plain" && nv.detectViewLang(null) === "plain", "空 / null → plain（不抛错）");
  ok(nv.detectViewLang("a: b") !== "md", "短 a: b 明确不是 md（计划要求的护栏）");
  ok(nv.analyzeTextView("# 标题").mdHits.heading === 1, "analyzeTextView 暴露证据分数（mdHits.heading），判定可解释可调试");
}

console.log("\n[9] nodeTextViewEl：三语言渲染 + YAML 无行号 + @引用着色不破坏 HTML");
{
  const nv = loadNodeView();
  const node = { id: "n1", kind: "proc_text", title: "P" };

  const y = flat(nv.nodeTextViewEl("- id: p1\n  name: 苹果\n", { node }));
  ok(y.lang === "yaml" && /\bntv-yaml\b/.test(y.cls), "YAML 文本 → data-view-lang=yaml 且带 .ntv-yaml");
  ok(allHtml(y).includes('class="yaml-k"'), "YAML 复用 highlightYamlLine 着色（key 有颜色）");
  ok(!/<span class="ln"|line-number/.test(allHtml(y)), "输出里没有行号列（浏览态只留内容）");
  ok(/\.map\(function \(line\) \{/.test(jsView), "YAML 逐行 map 不带下标 → 结构上不可能生成行号");
  ok(jsView.includes('pre.style.whiteSpace = "pre-wrap"'), "YAML 视图内联 pre-wrap → 缩进不被压成一行（字体字号仍交给 CSS）");

  const m = flat(nv.nodeTextViewEl("# 角色\n正文", { node }));
  ok(m.lang === "md" && /\bntv-md\b\b|\bntv-md\b/.test(m.cls), "Markdown 文本 → .ntv-md");
  ok(allHtml(m).includes("<h1>角色</h1>"), "Markdown 走 renderMarkdown（标题被正确渲染）");

  const p = flat(nv.nodeTextViewEl("普通文本 <b>粗</b> & 符号", { node }));
  ok(p.lang === "plain", "普通提示词 → plain");
  ok(allHtml(p).includes("&lt;b&gt;"), "plain 里的尖括号被转义（不当 HTML 解析）");
  ok(!allHtml(p).includes("<b>"), "转义后不会真的生成 <b> 元素");

  const e = flat(nv.nodeTextViewEl("   ", { node }));
  ok(e.lang === "plain" && allText(e).includes("（空）"), "空白内容 → 淡灰「（空）」占位（不再是冗长 placeholder）");

  const withCls = flat(nv.nodeTextViewEl("普通提示词一句话", { node, class: "n-view n-view-plain" }));
  ok(withCls.cls.includes("node-text-view") && withCls.cls.includes("n-view-plain"), "opts.class 可与 app-canvas.js 的 .n-view-* 约定并存（两套命名都命中 CSS）");

  const r = flat(nv.nodeTextViewEl("参考 @Alpha 与 @秋，忽略 @Nope", { node }));
  const rh = allHtml(r);
  ok(rh.includes('class="at-ref-node"') && rh.includes("var(--cyan)"), "@标题 保持青色引用色");
  ok(rh.includes('class="at-ref-tag"'), "@标签 保持紫色标签色");
  ok(!/at-ref-(node|tag)"[^>]*>@Nope/.test(rh), "@Nope（不存在的引用）不被染色");
  const href = nv.highlightAtRefsHtml('<a href="https://x.test/u@Alpha">@Alpha</a>', node);
  ok(href.includes('href="https://x.test/u@Alpha"'), "标签与属性原样保留（href 里的 @ 不被污染）");
  ok(/<a href="[^"]*">@Alpha<\/a>/.test(href.replace(/<span[^>]*>/g, "").replace(/<\/span>/g, "")), "@Alpha 只在标签之间的文本段上被包高亮");
  ok(nv.highlightAtRefsHtml("无 @ 的文本", node) === "无 @ 的文本", "没有 @ 时原样返回（零开销）");
  ok(nv.highlightAtRefsHtml("<i>@Alpha</i>", null) === "<i>@Alpha</i>", "无 node（拿不到候选）时不改一个字");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-browse-view)"
    : "\n✓ " + checks + " 项全部通过  (smoke-node-browse-view)",
);
process.exit(fails ? 1 : 0);
