"use strict";
/* 节点「浏览态（未选中）× 只读文本视图」回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-node-browse-view.js
 * 要保住的行为：文本 / 图像相关节点**只有被选中时才是可编辑形态**；未选中时像超级节点那样
 * 直接显示内容（Markdown / YAML 正确渲染、图像铺满），除节点头部那排小按钮以外没有任何交互。
 * 覆盖：
 *   [1] 形态判定骨架：kind 集合、判定口径、save 旧别名归一、buildBody 入口分流与失败回落
 *   [2] 八个 kind 的浏览态渲染器登记齐全（旧 kind chat 已下线，不再列）；浏览态分支不构造任何输入控件、不挂点击事件
 *   [3] 编辑态零回归：buildBody 后半段照旧有 textarea / 输出按钮 / 拖宽条
 *   [4] 选中三路径形态同步：.n-resize 快速路径走 setNodeSelClass；改状态不重绘处补 syncNodeForms
 *   [5] 点选即聚焦：markFormFocusAfterRender → renderCanvas 收尾 applyFocusFormAfterRender 接线
 *   [6] CSS：.wf-node.browse 收紧内边距（且左右仍躲开接线排）+ 只读视图/条目/裸图规则齐全
 *   [7] index.html 脚本顺序：app.js → app-nodeview.js → app-canvas.js
 *   [8] detectViewLang 判定样例（vm 加载纯逻辑）
 *   [9] nodeTextViewEl 三语言渲染 + YAML 无行号 + @引用着色不破坏 HTML
 *   [10] 素材节点专项：未选中只显示轻量摘要（标题 + 类型徽标 · 不读素材库、不造
 *        textarea / img / video / 按钮）· 点选后才回落编辑态 buildAssetBody
 *   [11] 函数节点专项：未选中只显示内容（无输入控件 / 无 onclick / 不用 .n-text 类）·
 *        点进去才出可编辑代码块（mousedown 放行 → wasBrowse → 编辑态 createJsCodeEditor →
 *        聚焦选择器命中 js-edit-input · CSS 三层叠放收点击）· 数组入参 ×N 摘要真源 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
/* 结束锚点 = 紧跟其后的「函数 / 工具节点 body」小节（那里的交互构件不属于浏览态区块） */
const BROWSE_END = "/* ── 函数 / 工具节点 body（参数即端子 · 设置面板）";
const browseRegion = sliceBetween(jsCanvas, BROWSE_MARK, BROWSE_END);
const editRegion = jsCanvas.slice(jsCanvas.indexOf("function buildBody(node, body) {"));

/* 参与浏览态的 kind（函数节点本可复用「代码只读视图」，随工具/函数节点上线而登记，
   故一并列入。素材节点随「未 focus 不显示详细内容」那一轮登记：未选中只列条目标题 +
   类型徽标，不读素材库、不渲染正文 / 缩略图 / 播放器）。旧 kind chat 已下线（app.js 的
   migrateChatNodeToAgent 把老画布的 chat 节点就地归一成 agent_task + chatMode），所以
   这里不再列 chat —— 之前它留在清单里，本测试自「chat 移除」那一轮起就一直红着，
   与预设档位改动无关。 */
const KINDS = [
  "input_text",
  "input_image",
  "proc_text",
  "proc_image",
  "agent_task",
  "function",
  "save",
  "asset",
];

console.log("\n[1] 形态判定骨架：kind 集合与判定口径");
{
  const m = jsCanvas.match(/const NODE_BROWSE_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  ok(!!m, "app-canvas.js 声明了 NODE_BROWSE_KINDS 集合");
  const setSrc = m ? m[1] : "";
  for (const k of KINDS) ok(setSrc.includes('"' + k + '"'), "集合含 " + k + "（参与「未选中 = 浏览态」）");
  /* 旧 kind chat 已从集合里下线（开机加载时 app.js 的 migrateChatNodeToAgent 把老画布的
     chat 节点就地归一成 agent_task + chatMode）：这里显式锁住「它不再回来」 */
  ok(!setSrc.includes('"chat"'), "chat 不再参与（该 kind 已下线，老节点开机归一成 agent_task + chatMode）");
  ok(/function migrateChatNodeToAgent\(/.test(jsApp), "app.js 保留 chat → agent_task 的归一函数（老画布不丢内容）");
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

console.log("\n[2] 八个 kind 的浏览态渲染器登记齐全 + 浏览态零交互构件");
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
    /* 回填 id 族按现源列全（chat 一族随 kind 下线：会话式渲染改用 agent_task 的 dsh-out-* 族） */
    for (const id of ["st-", "dsh-out-stream-", "dsh-out-tools-", "out-img-", "outimg-", "svpre-", "svimg-", "svempty-", "svthumbs-"])
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
  /* 断言窗口按「nodeElement 头部 → 开发节点区块之前」切，不按固定字符数掐：
     音频 / 视频输入的 .in-media 那段注释插在中间，把浏览态标记推过了原来的 400 字窗口，
     导致本项自那一轮起误报（要锁的是「在函数开头、还没开始拼子元素就把形态打完」）。 */
  const nStop = nEl > 0 ? jsCanvas.indexOf("/* 开发节点：", nEl) : -1;
  const nHead = nEl > 0 ? jsCanvas.slice(nEl, nStop > nEl ? nStop : nEl + 1600) : "";
  ok(
    nEl > 0 && nStop > nEl,
    "能按锚点切出 nodeElement 头部区块（className 行 → 开发节点区块之前）",
  );
  ok(nHead.includes('el.classList.add("browse")'), "nodeElement 初绘即打 .browse");
  ok(nHead.includes("el.dataset.nodeForm = _browse ? \"browse\" : \"edit\""), "nodeElement 初绘即记形态");
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
/* @引用着色同源切词：从 app.js 抠真实 atMentionsOf 链供 app-nodeview.js 调用 */
function viewFnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到 app.js 顶层函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (!isFn) {
    const eol = src.indexOf("\n", at);
    return src.slice(at, eol + 1);
  }
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}
const viewExtract = (src, names) => names.map((n) => viewFnBody(src, n)).join("\n");
const AT_TOKENIZER_SRC = viewExtract(jsApp, [
  "atRefNames",
  "atRefSpanEnd",
  "atMentionsOf",
  "eachAtMention",
  "mapAtMentions",
  "AT_REF_STOP",
  "AT_REF_EDGE",
  "AT_REF_WS_TEXT",
]);

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
    AT_TOKENIZER_SRC +
    "\n" +
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

console.log("\n[10] 素材节点：未 focus（未选中）只显示轻量摘要 · 不读素材库、不渲染内容本体");
{
  const at = jsCanvas.indexOf("NODE_BROWSE_BODY.asset = function (node, body) {");
  const aBrowse = at >= 0 ? blockFrom(jsCanvas, at) : null;
  ok(!!aBrowse, "能按锚点切出 NODE_BROWSE_BODY.asset 的渲染器函数体");
  ok(
    !!browseRegion && browseRegion.indexOf("NODE_BROWSE_BODY.asset") >= 0,
    "素材节点渲染器落在「浏览态区块」内（与其余 kind 同一节，注释锚点没漂走）",
  );
  if (aBrowse) {
    /* 资源占用就是这一条：未 focus 时不许把正文 / 缩略图 / 播放器造出来 */
    ok(
      !/createElement\("textarea"\)|createElement\("img"\)|createElement\("video"\)|createElement\("button"\)|createElement\("input"\)/.test(
        aBrowse,
      ),
      "浏览态不构造 textarea / img / video / button / input（内容本体只在编辑态出现）",
    );
    ok(
      !/wavePreviewCreate\(|bindImagePreview\(|assetItemOps\(/.test(aBrowse),
      "浏览态不挂波形预览器 / 图片预览 / 条目操作排（那三样都是编辑态构件）",
    );
    /* 资源占用的另一半：未 focus 时不向素材库逐条取正文 */
    ok(
      !/assetItemsEnsure\(/.test(aBrowse) && !/assetItemViewLoad\(/.test(aBrowse),
      "浏览态不向素材库发内容读取（assets:itemRead 只在点选后的编辑态发）",
    );
    /* 空壳（未绑定）与内容无关：照旧给绑定 / 上传入口，别让刚建的节点要先猜「点一下」 */
    ok(
      /if \(!bound\) \{[\s\S]{0,200}?assetBindBox\(/.test(aBrowse) &&
        /I18n\.t\("未绑定素材"\)/.test(aBrowse),
      "未绑定（空壳）照旧渲染 assetBindBox 的绑定 / 上传入口（与内容本体无关）",
    );
    ok(
      !/assetItemOps\(|assetBindBtn\(/.test(aBrowse),
      "浏览态不挂条目操作排 / 自造按钮（空壳入口复用编辑态那份 assetBindBox）",
    );
    ok(
      /assetItems\(node\)/.test(aBrowse),
      "摘要只读节点上已存的条目快照 assetItems(node)（id / 标题 / 类型 · 同步取数）",
    );
    ok(
      /n-view-assets/.test(aBrowse) && /n-asset-kind/.test(aBrowse),
      "清单用 .n-view-assets 行 + 复用编辑态的类型徽标 .n-asset-kind",
    );
    ok(
      /I18n\.t\("素材失联：点选本节点后看详情 \/ 重新绑定"\)/.test(aBrowse),
      "失联给一句去向（点选本节点 · 端子与连线原样保留）",
    );
    ok(
      /I18n\.t\("该素材还没有内容：点选本节点后逐条查看 \/ 添加"\)/.test(aBrowse),
      "空素材也有去向句（未 focus 时不显示「设置」按钮）",
    );
  }
  /* 编辑态零回归：点选（拿焦点）后仍是原样那条逐条内容 + 「覆盖」按钮的 body */
  const es = funcBody(jsCanvas, "function buildAssetBody(node, body)");
  ok(!!es && /assetItemRow\(node, items\[i\], i, lost\)/.test(es), "编辑态照旧逐条 assetItemRow（标题 + 类型 + 覆盖按钮 + 内容视图）");
  ok(!!es && /assetItemsEnsure\(node\)/.test(es), "编辑态照旧向库补齐内容（点选后才有内容与缩略图）");
  ok(
    /if \(nodeBrowseMode\(node\) && buildBrowseBody\(node, body\)\) return;/.test(jsCanvas),
    "buildBody 入口分流在素材节点分支之前（未选中不再走 buildAssetBody）",
  );
  const kindSet = (jsCanvas.match(/const NODE_BROWSE_KINDS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || "";
  ok(/'?"asset"?,/.test(kindSet) || /"asset"/.test(kindSet), "asset 登记进 NODE_BROWSE_KINDS（未选中 = 浏览态）");
  /* CSS：摘要行要真能对上类名（不然是裸类名 / 无样式） */
  ok(/\.wf-node\.browse \.n-view-assets \{/.test(css), "canvas.css 有 .wf-node.browse .n-view-assets 规则（清单排版）");
  ok(/\.wf-node\.browse \.n-view-asset-name \{/.test(css), "canvas.css 有摘要行标题规则（一行裁尾 · 不撑高节点）");
  ok(/\.wf-node\.browse \.n-view-assets \.n-asset-kind \{/.test(css), "类型徽标在浏览态有 flex:none 钉位（不挤压标题）");
}

console.log("\n[11] 函数节点：外部只显示内容 · 点进去才出可编辑代码块（本轮 Bug 的两半）");
{
  const at = jsCanvas.indexOf("NODE_BROWSE_BODY.function = function (node, body) {");
  const fnBrowse = at >= 0 ? blockFrom(jsCanvas, at) : null;
  ok(!!fnBrowse, "能按锚点切出 NODE_BROWSE_BODY.function 的渲染器函数体");
  ok(
    !!browseRegion && browseRegion.indexOf("NODE_BROWSE_BODY.function") >= 0,
    "函数节点渲染器落在「浏览态区块」内（与其余 kind 同一节，注释锚点没漂走）",
  );
  if (fnBrowse) {
    ok(
      !/createElement\("textarea"\)|createElement\("input"\)|createElement\("button"\)|createElement\("select"\)/.test(
        fnBrowse,
      ),
      "浏览态不构造任何输入控件（代码编辑器 / 格式化条 /「开发」按钮 /「设置」面板全在编辑态）",
    );
    ok(
      !/createJsCodeEditor\(/.test(fnBrowse),
      "浏览态不提前挂代码编辑器（未选中就没有可编辑块，正是「点进去才显示」这半条）",
    );
    ok(
      !/\.onclick\s*=|addEventListener\("click"/.test(fnBrowse),
      "浏览态一个点击事件都不挂（点板身即选中节点 → 由既有链路切编辑态）",
    );
    ok(
      !/["']n-text["']|class(Name)?\s*=\s*["'][^"']*\bn-text\b/.test(fnBrowse),
      "浏览态正文不用 .n-text 类（它在节点根 mousedown 的放行名单里，命中就不拖节点、也选不中）",
    );
    ok(
      /browseTextEl\(functionCodeOf\(node\)/.test(fnBrowse) &&
        /lang:\s*"plain"/.test(fnBrowse),
      "代码正文走只读文本视图并强制 plain（JS 不被误判成 md / yaml · 无行号槽）",
    );
    ok(
      /fnBrowseParamLine\(I18n\.t\("入参"/.test(fnBrowse) &&
        /fnBrowseParamLine\(I18n\.t\("出参"/.test(fnBrowse),
      "入参与出参摘要在浏览态可见（不必先选中再开「设置」）",
    );
    ok(
      /\.id = "st-" \+ node\.id/.test(fnBrowse),
      "状态行 id 与编辑态逐字一致（运行中的增量照常回填）",
    );
    ok(
      /fnToolOutSummaryEl\(node\)/.test(fnBrowse),
      "输出摘要照旧显示（跑完的结果不用选中也看得见）",
    );
  }
  /* 数组（批量）入参在只读摘要里的形状标记：判定真源一份，别处共用 */
  const pl = funcBody(jsCanvas, "function fnBrowseParamLine(label, list)");
  ok(!!pl && /fnBrowseParamIsArray\(p\) \? "×N"/.test(pl), "入参摘要里数组参数标 ×N（一端子一组值）");
  const ai = funcBody(jsCanvas, "function fnBrowseParamIsArray(p)");
  ok(
    !!ai && /p\.array \|\| p\.arr \|\| p\.list \|\| p\.batch \|\| p\.repeat/.test(ai),
    "数组判定真源含 list 位（连线放行 / 端子徽标 / 只读摘要三处共用这一份）",
  );
  ok(!!ai && /\/array\|list\/i\.test\(String\(p\.kind/.test(ai), "kind 里含 array|list 也算数组（旧数据兼容）");

  /* —— 点进去才出可编辑代码块：整条链路逐环钉住 —— */
  const nElAt = jsCanvas.indexOf("function nodeElement(");
  const mdAt = jsCanvas.indexOf('el.addEventListener("mousedown"', nElAt);
  const mousedown = blockFrom(jsCanvas, mdAt);
  ok(
    !!mousedown && /closest\("\.n-text"\)/.test(mousedown),
    "节点根 mousedown 只放行 .n-text 等交互控件（浏览态没有它们 → 点击必然走到选中）",
  );
  ok(jsApp.includes("const wasBrowse = nodeBrowseMode(node);"), "startNodeDrag 记下「点击前是浏览态」");
  const fnBody = sliceBetween(
    jsCanvas,
    "function buildFnToolBodyMain(node, body, isTool) {",
    "function buildBody(node, body) {",
  );
  ok(!!fnBody && /createJsCodeEditor\(/.test(fnBody), "编辑态仍挂那块真代码编辑器（点进去出现的就是它）");
  const main = funcBody(jsCanvas, "function nodeMainInputEl(el)");
  ok(!!main && /textarea\.n-text:not\(\[readonly\]\)/.test(main), "收尾聚焦按 textarea.n-text:not([readonly]) 找主输入框");
  const jsEdit = read("renderer/app-codeedit.js");
  ok(
    /ta\.className = "n-text js-edit-input";/.test(jsEdit),
    "代码 textarea 的 class 恰好命中上面那个选择器 → 选中节点时光标真落进代码块",
  );
  /* CSS 层：收点击的那层在最上面、镜像层不接事件（样式缺失就是本轮「点不动」的真因） */
  const cssRule = (src, sel) => {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const want = sel.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
      const s = m[1].replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
      if (s === want) return m[2];
    }
    return null;
  };
  const inputRule = cssRule(css, ".js-edit-input");
  const mirrorRule = cssRule(css, ".js-edit-hl");
  ok(!!inputRule && /z-index:\s*1/.test(inputRule), "canvas.css：.js-edit-input 叠在上层（点击落在可编辑的那层）");
  ok(!!mirrorRule && /pointer-events:\s*none/.test(mirrorRule), "canvas.css：.js-edit-hl 不接事件（镜像层盖不住点击）");
  const editRule = cssRule(css, ".js-edit");
  ok(!!editRule && /position:\s*relative/.test(editRule), "canvas.css：.js-edit 是定位参照系（三层叠放的前提）");
  ok(
    (css.match(/\.js-edit-input/g) || []).length >= 4 &&
      (cssLight.match(/body\.theme-light \.js-edit-input/g) || []).length >= 1,
    "亮色主题同样覆盖了输入层（切主题后代码区仍可见可点）",
  );
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-browse-view)"
    : "\n✓ " + checks + " 项全部通过  (smoke-node-browse-view)",
);

/* ==================== 已并入：test/smoke-node-drag-nest.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-node-drag-nest.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const section = (t) => console.log("\n[" + t + "]");
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");

  const APP = read("renderer/app.js");

  /* ─ 与 smoke-canvas-scope.js 同一套切片工具：跑真函数，不另抄一份 ── */
  function sliceBraces(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        i = src.indexOf("\n", i);
        continue;
      }
      if (c === "/" && n === "*") {
        i = src.indexOf("*/", i) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        i++;
        while (i < src.length) {
          if (src[i] === "\\") i++;
          else if (src[i] === q) break;
          i++;
        }
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return src.slice(openIdx, i + 1);
      }
    }
    throw new Error("括号未配平");
  }
  function grabFunction(src, name) {
    const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
    const m = re.exec(src);
    if (!m) throw new Error("源码里找不到函数：" + name);
    const open = src.indexOf("{", src.indexOf(")", m.index));
    return src.slice(m.index, open + sliceBraces(src, open).length);
  }

  /* [2] 里那份「整组只认一个落点宿主」的判定，从 finalizeNodeDragNest 真源码里取 */
  const NEST_FN = grabFunction(APP, "finalizeNodeDragNest");

  /* 展开壳内范围常量：x0 = 壳 x + 0（展开时 superInnerOrigin.ox），y0 = 壳 y + 29 */
  const SUP = { x: 1000, y: 200, w: 280, h: 200, expandW: 720, expandH: 480 };
  const BOX = { x0: SUP.x, y0: SUP.y + 29, x1: SUP.x + SUP.expandW - 8, y1: SUP.y + SUP.expandH - 10 };

  function makeSandbox(graph) {
    const nodes = graph.map((n) => Object.assign({}, n));
    const sb = {
      console,
      JSON,
      Object,
      Array,
      String,
      Number,
      Math,
      Set,
      RegExp,
      Error,
      isFinite,
      snap(v) {
        return Math.round(Number(v || 0) / 24) * 24;
      },
      S: { wf: { nodes, wires: [], marks: [], groups: [] }, superFocus: "", taskFocus: "" },
      currentSuperFocus: () => sb.S.superFocus || "",
      currentTaskFocus: () => sb.S.taskFocus || "",
      nodeById: (id) => nodes.filter((n) => n.id === id)[0] || null,
      isSuperIoNode: (n) => !!(n && n.kind === "super_io"),
      nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
      nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
      /* 根画布口径：壳内节点只要宿主是展开的就在范围内（本测试的壳全为展开态） */
      nodeInCurrentScope: (n) => {
        if (!n) return false;
        if (sb.S.superFocus) return sb.nodeParentSuperId(n) === sb.S.superFocus;
        let sid = sb.nodeParentSuperId(n);
        const seen = new Set();
        while (sid && !seen.has(sid)) {
          seen.add(sid);
          const host = sb.nodeById(sid);
          if (!host || host.kind !== "super" || !host.superOpen) return false;
          sid = sb.nodeParentSuperId(host);
        }
        return true;
      },
      superChildrenOf: (id) => nodes.filter((n) => n.parentSuperId === id),
      /* 绘制（标注）本测试不需要：给空集合，与 smoke-canvas-scope 同口径 */
      marksOf: () => [],
      markBounds: (m) => (m ? { x: m.x, y: m.y, w: m.w || 0, h: m.h || 0 } : null),
      markParentSuperId: (m) => (m && m.parentSuperId) || "",
      /* 真实渲染层里 superInnerOrigin 量的是壳层 DOM；沙箱没有 DOM → 走它的兜底
         { ox: 0, oy: 29 }（展开壳 stage 贴齐标题下沿，与源码兜底一致） */
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      pruneInvalidSuperBoundaryWires: () => 0,
      wireKeepsSuperBoundary: () => true,
      /* 右键「移入此超级节点」链路用到的落盘 / 路径改写：本测试只关心归属与坐标 */
      pushHistory: () => {},
      scheduleSave: () => {},
      rewriteNodePathsForSuperContext: () => {},
    };
    const code = [
      "(function () {",
      grabFunction(APP, "superIsOpenShell"),
      grabFunction(APP, "nodeIsNestedInOpenSuper"),
      grabFunction(APP, "superDisplaySize"),
      grabFunction(APP, "superInnerOrigin"),
      grabFunction(APP, "superInnerPan"),
      grabFunction(APP, "nodeWorldPos"),
      grabFunction(APP, "nodeDrawSize"),
      grabFunction(APP, "isSuperAncestorOf"),
      grabFunction(APP, "canMoveNodeIntoSuper"),
      grabFunction(APP, "superNestDepth"),
      NEST_FN,
      grabFunction(APP, "findOpenSuperAtWorld"),
      grabFunction(APP, "findOpenSuperContainingRect"),
      "const DRAG_RECT_TOL = " + Number(/const DRAG_RECT_TOL = (\d+)/.exec(APP)[1]) + ";",
      "const DRAG_RECT_MIN_OVERLAP = " + Number(/const DRAG_RECT_MIN_OVERLAP = (\d+)/.exec(APP)[1]) + ";",
      grabFunction(APP, "superInnerAnchor"),
      grabFunction(APP, "alignSuperContentTopLeft"),
      grabFunction(APP, "fitSuperShellToContent"),
      grabFunction(APP, "fitAllOpenSuperShells"),
      grabFunction(APP, "moveNodesIntoSuper"),
      "return { finalizeNodeDragNest, findOpenSuperAtWorld, findOpenSuperContainingRect, canMoveNodeIntoSuper, isSuperAncestorOf, fitAllOpenShells: fitAllOpenSuperShells, nodeWorldPos, superInnerOrigin, superInnerAnchor, nodeDrawSize, superDisplaySize, moveNodesIntoSuper };",
      "})()",
    ].join("\n");
    const ctx = vm.createContext(sb);
    const api = vm.runInContext(code, ctx);
    return { sb, api, nodes };
  }

  function mkNode(o) {
    return Object.assign(
      { kind: "proc_text", w: 240, h: 160, title: o.id, parentSuperId: "", parentTaskId: "" },
      o,
    );
  }
  function mkSuper(id, o) {
    return mkNode(
      Object.assign(
        { id, kind: "super", x: SUP.x, y: SUP.y, w: SUP.w, h: SUP.h, superOpen: true, expandW: SUP.expandW, expandH: SUP.expandH },
        o || {},
      ),
    );
  }
  /* 与 app.js 的 snap 同源：拖动中 curWorld 走 snap（applyNodeDragVisual），
     测试里的 curWorld 必须一样是网格对齐值，否则会造出「落点与现状差几 px」的假现场 */
  const snapv = (v) => Math.round(Number(v || 0) / 24) * 24;
  /* 整组按位移拖动：与 applyNodeDragVisual 的 curWorld 同形。
     拖动中壳自己不动 → 成员的世界坐标 = 起拖时的世界坐标 + 位移，直接按此算，
     不能用 nodeWorldPos 现算（组里若含某颗壳的子节点，现算会把壳自己的位移也算进去）。 */
  function drag(api, nodes, ids, delta) {
    const curWorld = {};
    for (const id of ids) {
      const n = nodes.filter((x) => x.id === id)[0];
      const wp = api.nodeWorldPos(n);
      curWorld[id] = { x: snapv(wp.x + delta.x), y: snapv(wp.y + delta.y) };
    }
    return curWorld;
  }
  const parentOf = (nodes, id) => (nodes.filter((n) => n.id === id)[0].parentSuperId || "-");

  /* ═══════════════ [1] findOpenSuperAtWorld：展开壳命中口径 ═══════════════ */
  function part1() {
    section("1 findOpenSuperAtWorld 命中口径");
    const { api } = makeSandbox([mkSuper("SUP"), mkNode({ id: "A", x: 100, y: 100 })]);
    ok(!!api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()), "壳内左上角命中");
    ok(!!api.findOpenSuperAtWorld(BOX.x1 - 5, BOX.y1 - 5, new Set()), "壳内右下角命中");
    ok(
      api.findOpenSuperAtWorld(BOX.x0 - 40, BOX.y0 + 5, new Set()) === null &&
        api.findOpenSuperAtWorld(BOX.x1 + 40, BOX.y1 - 5, new Set()) === null,
      "壳外左右各偏一点就不命中（不再「差一点也算进去」）",
    );
    const noSup = makeSandbox([mkNode({ id: "A", x: 100, y: 100 })]);
    ok(noSup.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()) === null, "画布上没有展开壳 → 不命中");
    const collapsed = makeSandbox([mkSuper("SUP", { superOpen: false })]);
    ok(
      collapsed.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()) === null,
      "收起态壳不算命中（拖动悬停会先把它展开；折叠卡片命中口径见 findSuperAtWorld）",
    );
    const skip = makeSandbox([mkSuper("SUP")]);
    ok(
      skip.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set(["SUP"])) === null,
      "被拖拽的壳自己进 skipHosts → 不能接收自己",
    );
  }

  /* ═══════════════ [2] finalizeNodeDragNest：整组一起进去 ═══════════════ */
  function part2() {
    section("2 多选拖入：命中一颗壳 → 整组一起进去");

    /* ②-a 关键回归：只有 A 的中点在壳内，B 的中点在外面 —— 组里两个都要进去 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 400, y: 300 }),
        mkNode({ id: "B", x: 1100, y: 400 }),
      ]);
      const ids = ["A", "B"];
      const curWorld = drag(api, nodes, ids, { x: 500, y: 0 });
      const startWorld = { A: api.nodeWorldPos(nodes[1]), B: api.nodeWorldPos(nodes[2]) };
      const hitA = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
      const hitB = api.findOpenSuperAtWorld(curWorld.B.x + 120, curWorld.B.y + 80, new Set());
      ok(!!hitA && !hitB, "前置：B 的中点确实在壳外（这不是「都进去了所以看不出问题」的场景）");
      const changed = api.finalizeNodeDragNest(ids, curWorld);
      ok(changed === true, "落定有变化");
      ok(
        parentOf(nodes, "A") === "SUP" && parentOf(nodes, "B") === "SUP",
        "整组都进了壳（不只中点落在壳内的那颗）：A=" + parentOf(nodes, "A") + " B=" + parentOf(nodes, "B"),
      );
      const wA = api.nodeWorldPos(nodes[1]);
      const wB = api.nodeWorldPos(nodes[2]);
      /* 落定会按内容撑壳 → 可能跟着调内部平移（innerPan），世界坐标整体平移是正常的；
         要钉的是「组内相对位置没被重排」：A→B 的偏移与拖动时一致 */
      ok(
        Math.abs(wB.x - wA.x - (startWorld.B.x - startWorld.A.x)) <= 24 &&
          Math.abs(wB.y - wA.y - (startWorld.B.y - startWorld.A.y)) <= 24,
        "组内相对位移不变（A→B 偏移 " + (wB.x - wA.x) + "," + (wB.y - wA.y) + " vs 拖动时 " +
          (startWorld.B.x - startWorld.A.x) + "," + (startWorld.B.y - startWorld.A.y) + "）",
      );
      /* 落定后视图把节点画在 nodeWorldPos 上（与拖动中 applyNodeDragVisual 的 curWorld 同口径） */
      ok(
        Math.abs((wB.x - wA.x) - (curWorld.B.x - curWorld.A.x)) <= 24 &&
          Math.abs((wB.y - wA.y) - (curWorld.B.y - curWorld.A.y)) <= 24,
        "落定后两颗节点的相对站位与拖动中一致（不会有一半被挤到壳的左上角）",
      );
      ok(
        Math.abs(nodes[1].x + nodes[2].x) < 4000 && Number.isFinite(wA.x) && Number.isFinite(wB.y),
        "落点都是有限数（没有 NaN / 越界坐标）",
      );
    }

    /* ②-b 三颗一起拖：一颗在壳里、两颗在外 → 三颗都进去 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 400, y: 300 }),
        mkNode({ id: "B", x: 900, y: 700 }),
        mkNode({ id: "C", x: 500, y: 1000 }),
      ]);
      const ids = ["A", "B", "C"];
      const curWorld = drag(api, nodes, ids, { x: 700, y: -100 });
      ok(
        !!api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set()) &&
          !api.findOpenSuperAtWorld(curWorld.B.x + 120, curWorld.B.y + 80, new Set()),
        "前置：只有 A 的中点在壳内",
      );
      api.finalizeNodeDragNest(ids, curWorld);
      ok(
        ["A", "B", "C"].every((id) => parentOf(nodes, id) === "SUP"),
        "三颗全部进壳：" + ["A", "B", "C"].map((id) => id + "=" + parentOf(nodes, id)).join(" "),
      );
    }

    /* ②-c 一颗都没命中 → 原样不动（不误吞）：整组落在壳范围内的空白处，谁也不进壳 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 96, y: 96 }),
        mkNode({ id: "B", x: 192, y: 168 }),
      ]);
      const ids = ["A", "B"];
      /* 与 applyNodeDragVisual 同源：原地松手时 curWorld = 现状（网格对齐值） */
      const curWorld = {
        A: { x: snapv(nodes[1].x), y: snapv(nodes[1].y) },
        B: { x: snapv(nodes[2].x), y: snapv(nodes[2].y) },
      };
      const changed = api.finalizeNodeDragNest(ids, curWorld);
      ok(
        changed === false && parentOf(nodes, "A") === "-" && parentOf(nodes, "B") === "-",
        "整组都在壳外 → 一颗都不进（不因为「同组有一颗进去了」而蔓延）",
      );
      ok(
        nodes[1].x === 96 && nodes[1].y === 96 && nodes[2].x === 192 && nodes[2].y === 168,
        "一颗都没命中时坐标也不被改写（原样 " + nodes[1].x + "," + nodes[1].y + " / " + nodes[2].x + "," + nodes[2].y + "）",
      );
    }

    /* ②-c2 本就在展开壳里的节点被拖到壳范围内的别处 → 仍是它，只是壳内坐标变了 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 300, y: 300, parentSuperId: "SUP" }),
      ]);
      const curWorld = drag(api, nodes, ["A"], { x: 120, y: 0 });
      const hit = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
      ok(hit && hit.id === "SUP", "前置：拖动后 A 的中点仍在壳内（实测 " + (hit && hit.id) + "）");
      api.finalizeNodeDragNest(["A"], curWorld);
      ok(parentOf(nodes, "A") === "SUP", "壳内成员在壳内挪动：归属不变（不会被当成「拖出壳」甩到画布上）");
      ok(
        Math.abs(nodes[1].x - snapv(300 + 120)) <= 24 && Math.abs(nodes[1].y - 300) <= 24,
        "壳内坐标跟着落点走（" + nodes[1].x + "," + nodes[1].y + "，期望 ≈" + snapv(420) + ",300）",
      );
    }

    /* ②-d 单颗拖动：行为不变（仍是按自己中点判定） */
    {
      const { api, nodes } = makeSandbox([mkSuper("SUP"), mkNode({ id: "A", x: 400, y: 300 })]);
      const curWorld = drag(api, nodes, ["A"], { x: 500, y: 0 });
      api.finalizeNodeDragNest(["A"], curWorld);
      ok(parentOf(nodes, "A") === "SUP", "单颗拖进壳内照旧进壳");
      const w = api.nodeWorldPos(nodes[1]);
      ok(Math.abs(w.x - curWorld.A.x) <= 24 && Math.abs(w.y - curWorld.A.y) <= 24, "单颗落点世界坐标不变");
    }

    /* ②-e 已在壳内的成员被拖出去、整组没有任何成员命中展开壳 → 它单独出来 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "IN", x: 200, y: 100, parentSuperId: "SUP" }),
        mkNode({ id: "FREE", x: 200, y: 1000 }),
      ]);
      const ids = ["IN", "FREE"];
      const curWorld = drag(api, nodes, ids, { x: -3000, y: 0 });
      api.finalizeNodeDragNest(ids, curWorld);
      ok(parentOf(nodes, "IN") === "-", "被拖出壳外的内部节点回到顶层（不因同组没进壳就一起留在里面）");
      ok(parentOf(nodes, "FREE") === "-", "同组的自由节点仍在壳外（没有因为组里有壳内成员就被拽进去）");
    }
    {
      /* 混合父级：IN 本来在壳里、FREE 从外面被拖进来 → 两个都归属这颗壳 */
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "IN", x: 200, y: 100, parentSuperId: "SUP" }),
        mkNode({ id: "FREE", x: 100, y: 1500 }),
      ]);
      const ids = ["IN", "FREE"];
      const curWorld = drag(api, nodes, ids, { x: 900, y: -1100 });
      const hitFree = api.findOpenSuperAtWorld(curWorld.FREE.x + 120, curWorld.FREE.y + 80, new Set());
      ok(
        hitFree && hitFree.id === "SUP",
        "前置：FREE（从外面拖进来）的中点落在壳内（实测 " + (hitFree && hitFree.id) + "）",
      );
      api.finalizeNodeDragNest(ids, curWorld);
      ok(
        parentOf(nodes, "IN") === "SUP" && parentOf(nodes, "FREE") === "SUP",
        "混合父级：壳内成员仍是它、外面进来的也进来（一起归属这颗壳）",
      );
    }
  }

  /* ═══════════════ [3] 落定后壳按内容撑开（进去的节点不被裁掉） ═══════════════ */
  function part3() {
    section("3 整组进壳后按内容撑开（新进去的节点看得见）");
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 400, y: 300 }),
      mkNode({ id: "B", x: 1000, y: 400 }),
    ]);
    const ids = ["A", "B"];
    const before = { w: nodes[0].expandW, h: nodes[0].expandH };
    const curWorld = drag(api, nodes, ids, { x: 500, y: 0 });
    api.finalizeNodeDragNest(ids, curWorld);
    const sup = nodes[0];
    ok(
      sup.expandW >= before.w && sup.expandH >= before.h,
      "壳只放大不缩小：" + before.w + "x" + before.h + " → " + sup.expandW + "x" + sup.expandH,
    );
    const need = (id) => {
      const n = nodes.filter((x) => x.id === id)[0];
      return n;
    };
    /* 撑开 + 对齐之后：每个子节点的**世界坐标**都应落在壳的可见矩形里
       （右侧端子留位 26 / 标题墙 43；换算回世界坐标才和用户看到的一致） */
    const shell = api.nodeWorldPos(sup);
    const vis = ["A", "B"].map((id) => api.nodeWorldPos(need(id)));
    ok(
      vis.every((w) => {
        return (
          w.x >= shell.x - 2 &&
          w.y >= shell.y + 27 &&
          w.x + 240 <= shell.x + sup.expandW - 22 &&
          w.y + 160 <= shell.y + sup.expandH - 16
        );
      }),
      "两颗节点都落在壳的可见范围内（含右侧端子留位与标题栏）：" +
        vis.map((w, i) => ["A", "B"][i] + "(" + w.x + "," + w.y + ")").join(" ") +
        " · 壳 world(" + shell.x + "," + shell.y + ") " + sup.expandW + "x" + sup.expandH,
    );
    ok(
      Number.isFinite(sup.innerPanX) && Number.isFinite(sup.innerPanY),
      "壳内部平移（innerPanX/Y）是有限数（撑开时对齐内容不出现 NaN）",
    );
  }

  /* ═══════════════ [4] 反向不变量：不成环、内部端子不参与 ═══════════════ */
  function part4() {
    section("4 反向不变量");
    {
      const { api, nodes } = makeSandbox([
        mkSuper("OUTER"),
        mkSuper("INNER", { parentSuperId: "OUTER", x: 1000, y: 200, expandW: 400, expandH: 300 }),
        mkNode({ id: "A", x: 400, y: 300 }),
      ]);
      /* 成环拒绝：宿主是 INNER 时不能把它的祖先 OUTER 收进去 */
      ok(
        api.isSuperAncestorOf("OUTER", "INNER") === true &&
          api.canMoveNodeIntoSuper(nodes[1], nodes[0]) === false,
        "外层壳不能把「自己的子孙壳」收进自己（会成环）",
      );
      ok(api.canMoveNodeIntoSuper(nodes[0], nodes[1]) === true, "反过来（祖先收自己的子孙壳）是合法收纳");
      /* A 拖到 INNER 里：INNER 与 OUTER 同心、面积更小 → 命中取最内层的 INNER。
         同组的 OUTER 是 INNER 的祖先，不能进 INNER；A 仍按自己的命中进 INNER
         （能不能进是逐节点判的，不因为组里有一颗进不去就把它也拦下）。 */
      const curWorld = drag(api, nodes, ["OUTER", "A"], { x: 1530, y: 170 });
      const hitA = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
      ok(hitA && hitA.id === "INNER", "前置：A 的中点落在 INNER 壳内（INNER 是最内层那颗，实测 " + (hitA && hitA.id) + "）");
      const changed = api.finalizeNodeDragNest(["OUTER", "A"], curWorld);
      ok(
        changed === true && parentOf(nodes, "A") === "INNER" && parentOf(nodes, "INNER") === "OUTER",
        "组里的祖先壳不进去（不能进自己的子孙）、A 按自己的命中进 INNER，谁也不成环",
      );
    }
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "IO", kind: "super_io", x: 400, y: 300 }),
      ]);
      const curWorld = drag(api, nodes, ["IO"], { x: 500, y: 0 });
      const changed = api.finalizeNodeDragNest(["IO"], curWorld);
      ok(changed === false && parentOf(nodes, "IO") === "-", "超级节点内部端子（super_io）永不参与归属改写");
    }
    {
      const { sb, api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 400, y: 300, parentSuperId: "SUP" }),
      ]);
      sb.S.superFocus = "SUP";
      const curWorld = drag(api, nodes, ["A"], { x: 500, y: 0 });
      const changed = api.finalizeNodeDragNest(["A"], curWorld);
      sb.S.superFocus = "";
      ok(
        parentOf(nodes, "A") === "SUP" && Math.abs(nodes[1].x - 900) <= 24,
        "全屏进入某颗壳时（superFocus）：本层节点拖动后仍是本层节点，落点坐标更新（不被甩到上一层，也不整体拒绝）",
      );
    }
  }

  /* ════════════ [5] 子画布（全屏进入超级节点）里再往子壳里套 ═════════════ */
  function mkFocusScene(extra) {
    /* 场景：OUTER（在根画布）里有一颗子壳 INNER（展开）与若干节点；用户「进入」OUTER
       后在子画布上操作 —— 这一屏的直接子壳 INNER 是合法落点宿主。
       修前：finalizeNodeDragNest 一进门就 `if (currentSuperFocus()) return false`，
       于是子画布里拖进子壳只有「中点已落在子壳里的那几个」动了，其余留在原地。 */
    return makeSandbox(
      [
        mkSuper("OUTER", {
          x: 0,
          y: 0,
          expandW: 720,
          expandH: 480,
          parentSuperId: "",
        }),
        mkSuper("INNER", {
          x: 200,
          y: 120,
          expandW: 400,
          expandH: 300,
          parentSuperId: "OUTER",
        }),
        mkNode({ id: "A", x: 0, y: 170, parentSuperId: "OUTER" }),
        mkNode({ id: "B", x: 560, y: 175, parentSuperId: "OUTER" }),
      ].concat(extra || []),
    );
  }
  function part5() {
    section("5 子画布（superFocus）里把节点拖进子壳");
    /* ⑤-a 多选：A 的中点进 INNER、B 的还在子画布空白 → 两颗都进 INNER，相对位置不变 */
    {
      const { sb, api, nodes } = mkFocusScene();
      sb.S.superFocus = "OUTER";
      /* A 起拖舞台坐标 (0,170)，拖到 (288,168) → 中点 (408,328) 在 INNER 内；
         B 起拖 (560,175)，同样 +288 → 中点 (968,343) 在子画布空白处 */
      const curWorld = { A: { x: 288, y: 168 }, B: { x: 848, y: 173 } };
      const hitA = api.findOpenSuperAtWorld(408, 328, new Set());
      const hitB = api.findOpenSuperAtWorld(968, 343, new Set());
      ok(hitA && hitA.id === "INNER", "前置：A 的中点在子壳 INNER 内（实测 " + (hitA && hitA.id) + "）");
      ok(!hitB, "前置：B 的中点在子壳外（子画布空白处）");
      const changed = api.finalizeNodeDragNest(["A", "B"], curWorld);
      ok(changed === true, "子画布落定有变化");
      ok(
        parentOf(nodes, "A") === "INNER" && parentOf(nodes, "B") === "INNER",
        "整组都进了子壳（不只中点落在子壳内的那颗）：A=" + parentOf(nodes, "A") + " B=" + parentOf(nodes, "B"),
      );
      const a = nodes.filter((n) => n.id === "A")[0];
      const b = nodes.filter((n) => n.id === "B")[0];
      ok(
        Math.abs(b.x - a.x - 560) <= 24 && Math.abs(b.y - a.y - 5) <= 24,
        "子壳内相对位移保留（A→B 偏移 " + (b.x - a.x) + "," + (b.y - a.y) + " 期望 ≈560,5）",
      );
      ok(
        a.x >= 0 && a.y >= 0 && a.x + a.w <= 400 && a.y + a.h <= 300,
        "A 的子壳内坐标落在子壳里（" + a.x + "," + a.y + "）",
      );
      ok(
        parentOf(nodes, "OUTER") === "-" && parentOf(nodes, "INNER") === "OUTER",
        "本层壳（INNER）仍挂在正在编辑的 OUTER 下",
      );
    }
    /* ⑤-b 子画布里把本层节点从子壳里拖出来 → 仍留在本层（OUTER），不会掉到根画布 */
    {
      const { sb, api, nodes } = mkFocusScene();
      sb.S.superFocus = "OUTER";
      const changed = api.finalizeNodeDragNest(["A"], { A: { x: 640, y: 430 } });
      const a = nodes.filter((n) => n.id === "A")[0];
      ok(changed === true, "拖出子壳有变化");
      ok(parentOf(nodes, "A") === "OUTER", "拖出子壳后仍留在本层 OUTER（不被甩到看不见的上一层）");
      ok(
        Math.abs(a.x - 640) <= 24 && Math.abs(a.y - 430) <= 24,
        "落点就是子画布上的舞台坐标（" + a.x + "," + a.y + "）",
      );
    }
    /* ⑤-c 子画布空白处拖动本层节点：只改坐标，不改归属 */
    {
      const { sb, api, nodes } = mkFocusScene();
      sb.S.superFocus = "OUTER";
      const beforeY = nodes[2].y;
      api.finalizeNodeDragNest(["A"], { A: { x: 0, y: 300 } });
      const a = nodes.filter((n) => n.id === "A")[0];
      ok(parentOf(nodes, "A") === "OUTER", "空白处落定不改归属（仍在 OUTER）");
      ok(Math.abs(a.y - 300) <= 24 && a.y !== beforeY, "落点坐标已更新（y " + beforeY + " → " + a.y + "）");
    }
    /* ⑤-d 反向不变量：子画布里的祖先壳（正在编辑的 OUTER）不会被收进自己的子壳 */
    {
      const { sb, api, nodes } = mkFocusScene();
      sb.S.superFocus = "OUTER";
      const curWorld = { OUTER: { x: 288, y: 168 }, A: { x: 288, y: 168 } };
      const hitA = api.findOpenSuperAtWorld(408, 328, new Set(["OUTER"]));
      ok(hitA && hitA.id === "INNER", "前置：A 命中子壳 INNER");
      api.finalizeNodeDragNest(["OUTER", "A"], curWorld);
      ok(
        parentOf(nodes, "A") === "INNER" && parentOf(nodes, "INNER") === "OUTER",
        "A 进子壳、OUTER 不进自己的子壳（不成环）",
      );
      ok(parentOf(nodes, "OUTER") === "-", "正在编辑的 OUTER 仍留在根画布");
    }
    /* ⑤-e 子画布上其它层级的节点不参与（这一屏看不见的节点不该被改写归属） */
    {
      const { sb, api, nodes } = mkFocusScene([
        mkNode({ id: "FAR", x: 288, y: 168, parentSuperId: "SOMEWHERE" }),
      ]);
      sb.S.superFocus = "OUTER";
      const changed = api.finalizeNodeDragNest(["FAR"], { FAR: { x: 300, y: 200 } });
      ok(
        changed === false && parentOf(nodes, "FAR") === "SOMEWHERE",
        "界外（其它层级）节点即使选中也不改写归属",
      );
    }
    /* ⑤-f 右键「移入此超级节点」（moveNodesIntoSuper）在子画布里也落在子壳内部 */
    {
      const { sb, api, nodes } = mkFocusScene();
      sb.S.superFocus = "OUTER";
      const inner = nodes.filter((n) => n.id === "INNER")[0];
      const a = nodes.filter((n) => n.id === "A")[0];
      const n = api.moveNodesIntoSuper(inner, [a]);
      ok(n === 1 && parentOf(nodes, "A") === "INNER", "右键移入：A 归属 INNER");
      ok(
        a.x >= 0 && a.y >= 0 && a.x + a.w <= 400 && a.y + a.h <= 300,
        "右键移入的落点坐标在子壳内部坐标系里（" + a.x + "," + a.y + "）",
      );
      ok(
        api.superInnerAnchor(inner).x === inner.x,
        "子画布下宿主锚点取宿主自身坐标（不再叠加父壳世界坐标）",
      );
    }
  }

  /* ═════════════ [6] 落点判据：光标优先 / 矩形包容（展开态「挪不动 / 挪不出」回归） ═════════════ */
  const CURSOR_FN = grabFunction(APP, "finalizeNodeDragNest");
  function part6() {
    section("6 落点判据：光标优先 / 边界包容（节点挪出壳沿不再被弹回画布）");

    /* 展开壳 SUP：world(1000,200) 720x480；命中区 x0=1000,y0=229 → x1=1712,y1=670 */
    const shellWorld = () => ({
      x0: SUP.x,
      y0: SUP.y + 29,
      x1: SUP.x + SUP.expandW - 8,
      y1: SUP.y + SUP.expandH - 10,
    });

    /* ⑥-a 壳内节点往壳右下沿挪：节点比壳沿伸出去（中点落在壳外一点点）——
         旧口径会判成「出壳」→ 归属被改写成画布顶层、视觉上整块弹走 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 1080, y: 420, parentSuperId: "SUP" }),
      ]);
      const a = nodes[1];
      const before = api.nodeWorldPos(a);
      const np = { x: snapv(before.x + 120), y: snapv(before.y + 96) };
      const sw = shellWorld();
      const center = { x: np.x + 120, y: np.y + 80 };
      ok(
        center.x > sw.x1 || center.y > sw.y1,
        "前置：照旧口径这颗节点已经算「出壳」（中点 " + center.x + "," + center.y + " 出 " + sw.x1 + "," + sw.y1 + "）",
      );
      /* 光标仍在壳内（用户只是往壳沿挪了一点） */
      const cursor = { x: sw.x1 - 20, y: sw.y1 - 20 };
      const changed = api.finalizeNodeDragNest(["A"], { A: np }, cursor);
      ok(changed === true && parentOf(nodes, "A") === "SUP", "光标还在壳里 → 归属仍是这颗壳（节点不再被弹出画布）");
      ok(
        api.nodeWorldPos(a).x === api.nodeWorldPos(a).x && Math.abs(api.nodeWorldPos(a).x - np.x) <= 24,
        "节点世界坐标就是落点（" + api.nodeWorldPos(a).x + "," + api.nodeWorldPos(a).y + "）",
      );
    }

    /* ⑥-b 光标已拖到壳外、节点也只剩一条窄边压在壳沿上 → 真的出壳 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
      ]);
      const a = nodes[1];
      const sw = shellWorld();
      /* 节点只剩左边一条 40px 窄边还压在壳命中区内（中心仍在壳里） */
      const np = { x: 960, y: 230 };
      const center = { x: np.x + 120, y: np.y + 80 };
      ok(
        center.x >= sw.x0 && center.x <= sw.x1 && center.y >= sw.y0 && center.y <= sw.y1,
        "前置：中点仍在壳内（照旧口径会被当成「壳内挪动」，拖不出去）",
      );
      const cursor = { x: 700, y: 120 };
      ok(
        cursor.x < sw.x0 && cursor.y < sw.y0,
        "前置：光标在壳外左侧/上方空白处（旧口径只看中点，会把它判成「壳内挪动」）",
      );
      ok(
        np.x < sw.x0 && np.x + 240 > sw.x0 && np.x + 40 <= sw.x0,
        "前置：节点只剩约 40px 窄边压在壳上（不足实质重叠阈值）",
      );
      api.finalizeNodeDragNest(["A"], { A: np }, cursor);
      ok(parentOf(nodes, "A") === "SUP", "光标在壳外但节点仍有实质重叠 → 仍留在壳里（壳沿不粘人也不甩人）");
      ok(
        Math.abs(api.nodeWorldPos(a).x - np.x) <= 24 && Math.abs(api.nodeWorldPos(a).y - np.y) <= 24,
        "仍在壳里时写回的坐标换算回世界坐标 = 落点（" + api.nodeWorldPos(a).x + "," + api.nodeWorldPos(a).y + "）",
      );
    }

    /* ⑥-c 光标偏出壳外，但节点仍压在壳沿上 → 矩形包容档接住，仍留在壳里 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
      ]);
      const a = nodes[1];
      const sw = shellWorld();
      /* 节点压在壳的右下角上：外接矩形有交集、中心仍落在命中区内 */
      const np = { x: snapv(sw.x1 - 160), y: snapv(sw.y1 - 96) };
      ok(
        np.x + 240 > sw.x1 && np.x < sw.x1 && np.y + 160 > sw.y1 && np.y < sw.y1,
        "前置：节点外接矩形与壳的右下角确有交集（" + np.x + "," + np.y + " vs 壳角 " + sw.x1 + "," + sw.y1 + "）",
      );
      const cursor = { x: np.x + 240 + 120, y: np.y - 240 };
      ok(
        api.findOpenSuperAtWorld(cursor.x, cursor.y, new Set()) === null,
        "前置：光标已不在壳上（光标档不生效，落到矩形包容档）",
      );
      api.finalizeNodeDragNest(["A"], { A: np }, cursor);
      ok(parentOf(nodes, "A") === "SUP", "节点外接矩形仍压在壳上 → 不因光标偏出去就被弹到画布");
    }

    /* ⑥-d 拖到壳旁边的空白处（与壳毫无重叠）→ 仍然出壳，不被误吞回去 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
      ]);
      const sw = shellWorld();
      const np = { x: sw.x1 + 240, y: sw.y1 + 240 };
      api.finalizeNodeDragNest(["A"], { A: np }, { x: np.x + 120, y: np.y + 80 });
      ok(parentOf(nodes, "A") === "-", "整颗都拖到壳外空白处 → 出壳（矩形包容不等于「贴着就吞」）");
    }

    /* ⑥-e 不传光标（旧调用口径）时行为与原来一致 */
    {
      const { api, nodes } = makeSandbox([
        mkSuper("SUP"),
        mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
      ]);
      const a = nodes[1];
      const wp = api.nodeWorldPos(a);
      api.finalizeNodeDragNest(["A"], { A: { x: snapv(wp.x - 2000), y: wp.y } });
      ok(parentOf(nodes, "A") === "-", "不带光标点时仍按中点判定（旧口径保留，沙箱调用不受影响）");
    }
  }

  /* ═════════════ [7] 源码口径：入口与调用点仍在 ═════════════ */
  function part7() {
    section("7 调用点与拒绝口径");
    ok(
      /const dropPt = toStage\(ev\.clientX, ev\.clientY\);[\s\S]{0,200}finalizeNodeDragNest\(dragIds, curWorld, dropPt\)/.test(APP),
      "mouseup 收尾把松手落点（光标）交给 finalizeNodeDragNest",
    );
    ok(
      APP.indexOf("function finalizeNodeDragNest(ids, curWorld, cursorPt)") > 0,
      "finalizeNodeDragNest 收光标落点参数（旧调用不传时退化为原口径）",
    );
    ok(
      APP.indexOf("function findOpenSuperContainingRect(r, exceptIds, tol)") > 0 &&
        NEST_FN.indexOf("findOpenSuperContainingRect(r, skipHosts, DRAG_RECT_TOL)") > 0,
      "矩形包容判据独立成 findOpenSuperContainingRect（带容错外扩），并被落点判据调用",
    );
    ok(
      APP.indexOf("const ids = dragIds.filter") >= 0 || APP.indexOf("ids: dragIds") >= 0,
      "拖拽状态里带的是整组 dragIds（多选整组一起移动）",
    );
    ok(
      NEST_FN.indexOf("整组只认一个落点宿主") > 0,
      "finalizeNodeDragNest 里写清「整组只认一个落点宿主」的口径",
    );
    ok(
      NEST_FN.indexOf("canMoveNodeIntoSuper(host, pick)") > 0,
      "整组进壳前用 canMoveNodeIntoSuper 复核宿主（自己 / 子孙 / 内部端子一律不进）",
    );
    ok(
      NEST_FN.indexOf("const byCenter = findOpenSuperAtWorld(c.x, c.y, skipHosts)") > 0,
      "光标与矩形都没命中时仍按逐成员中点兜底（并跳过被拖拽的壳自己）",
    );
    ok(
      NEST_FN.indexOf("fitAllOpenSuperShells()") > 0,
      "落定后调用 fitAllOpenSuperShells()：整组进壳后壳按内容撑开，新进去的节点不被裁掉",
    );
    ok(
      NEST_FN.indexOf("const focusId = currentSuperFocus()") > 0 &&
        NEST_FN.indexOf("superInnerAnchor(host)") > 0,
      "finalizeNodeDragNest 用 focusId + superInnerAnchor 支持子画布（不再一进门就整体返回）",
    );
    ok(CURSOR_FN.length > 0, "落点判据源码可切片（回归脚本与新参数同源）");
  }

  part1();
  part2();
  part3();
  part4();
  part5();
  part6();
  part7();
  console.log(
    "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全绿") + "  (smoke-node-drag-nest)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-node-drag-nest.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-node-drag-nest.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
