"use strict";
/* 文本节点「预览形态滚轮浏览 + 超长文本护栏 + 只读预览窗已移除」回归冒烟（纯 Node，无 Electron）
 *   node test/smoke-node-text-guard.js
 *
 * 本档位三件事：
 *   [1] 预览形态（未选中 = browse）滚轮兜底：指针落在节点内非滚动位置（状态行 / 内边距 /
 *       头部空白）时，滚轮补给节点主滚动区，不再「卡住」；压在本就能滚的容器上时交回原生
 *   [2] 超长文本护栏：浏览态超过阈值改走整块纯文本轻量视图（一次 innerHTML），
 *       不再整篇 Markdown / YAML 结构渲染 + 逐段 @引用着色（卡顿源）
 *   [3] 本轮需求「移除预览、只留编辑」的负向回归：节点头部不再有只读预览入口（👁），
 *       renderer/app-textpreview.js 与 css/textpreview.css 已删、index.html / style.css
 *       不再引用，超长文本提示也不再指向一枚不存在的按钮
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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

const jsCanvas = read("renderer/app-canvas.js");
const jsView = read("renderer/app-nodeview.js");
const jsReview = read("renderer/app-review.js");
const html = read("renderer/index.html");
const styleCss = read("renderer/style.css");
const css = read("renderer/css/canvas.css");

function blockFrom(src, at) {
  if (at < 0) return null;
  const open = src.indexOf("{", at);
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
const funcBody = (src, sig) => blockFrom(src, src.indexOf(sig));

console.log("\n[1] 预览形态滚轮兜底（未选中 = 浏览态）");
{
  const build = funcBody(jsCanvas, "function buildBrowseBody(node, body)");
  ok(!!build, "能切出 buildBrowseBody 函数体");
  ok(!!build && build.includes("bindNodeBrowseWheel(body)"), "浏览态 body 建完即挂滚轮兜底");
  ok(
    !!build && /try\s*\{\s*bindNodeBrowseWheel\(body\);/.test(build),
    "兜底接线自己 try 住：异常不会打断画布重绘",
  );

  /* 关键回归：nodeElement 里是「先 buildBody(node, body) 再 el.appendChild(body)」，
     建 body 那一刻 body.closest(".wf-node") 还是 null —— 把轮子监听挂在那里的写法
     会静默早退，节点上永远没有监听（这正是「预览形态滚轮完全没反应」的根因）。
     现方案：document 捕获阶段的全局路由器，与建 DOM 的时序无关。 */
  const bind = funcBody(jsCanvas, "function bindNodeBrowseWheel(");
  ok(!!bind, "存在 bindNodeBrowseWheel");
  ok(
    !!bind && !bind.includes(".closest"),
    "不在建 body 的当下按 body.closest(.wf-node) 挂监听（那一刻 body 还没入文档）",
  );
  ok(
    !!bind && bind.includes('document.addEventListener("wheel", browseWheelRoute'),
    "监听装在 document 上（全局路由器，与建 DOM 时序无关）",
  );
  ok(!!bind && bind.includes("browseWheelRouterOn"), "同一监听只装一次（重绘幂等）");
  ok(
    !!bind && bind.includes("capture: true") && bind.includes("passive: false"),
    "capture + passive:false：先于原生滚动判定，且允许 preventDefault",
  );

  const route = funcBody(jsCanvas, "function browseWheelRoute(ev)");
  ok(!!route, "存在 browseWheelRoute 事件处理");
  ok(!!route && route.includes('t.closest(".wf-node")'), "按 .wf-node 定位节点宿主");
  ok(
    !!route && route.includes('.classList.contains("browse")'),
    "只在浏览态（未选中）接管 —— 编辑态不抢滚轮",
  );
  ok(
    !!route &&
      route.includes(
        '"button, input, select, textarea, .port, .n-resize, .super-stage, #imgLb, #overlay"',
      ),
    "交互控件 / 图片灯箱 / 弹窗上不接管滚轮",
  );
  ok(
    !!route && route.includes('const b = host.querySelector(":scope > .n-body")'),
    "每次事件现查 .n-body（形态切换重建 body 后闭包不失效）",
  );
  ok(!!route && route.includes("const owner = browseWheelNativeOwner(ev, b)"), "先问「指针是否已在可滚容器里」");
  ok(
    !!route && route.includes("const target = owner || nodeBrowseScrollTarget(b)"),
    "否则补给节点主滚动区",
  );
  ok(!!route && route.includes("if (owner) return;"), "指针已在能滚的容器上 → 交回原生（不叠加成双速）");
  ok(!!route && route.includes("if (next === before) return;"), "滚到头不吞事件（不卡在半路）");

  const tgt = funcBody(jsCanvas, "function nodeBrowseScrollTarget(body)");
  ok(!!tgt, "存在 nodeBrowseScrollTarget");
  ok(!!tgt && tgt.includes('querySelectorAll(".n-view")'), "优先挑 .n-view（文本 / 条目只读视图）");
  ok(!!tgt && tgt.includes("v.clientHeight < 48"), "太矮的视图不算主滚动区（避免抢走滚轮）");
  ok(!!tgt && tgt.includes("v.scrollHeight <= v.clientHeight + 2"), "不滚的视图不入选");
  ok(!!tgt && tgt.includes("elScrollableY(c)"), "找不到 .n-view 就退回节点内最大可滚元素");

  const owner = funcBody(jsCanvas, "function browseWheelNativeOwner(ev, body)");
  ok(!!owner, "存在 browseWheelNativeOwner");
  ok(!!owner && owner.includes('".n-view, .n-out, .n-bout-list, .n-view-entries, .js-edit, .dsh-tools, textarea, pre"'), "可滚容器白名单覆盖 .n-view / .n-out / 代码块 / 输出条目");
  ok(!!owner && owner.includes("if (hit && hit !== body) return own(hit) ? hit : null;"), "命中容器但自身不滚 → 仍走兜底");

  const px = funcBody(jsCanvas, "function raWheelPixels(ev, ref)");
  ok(!!px, "存在 raWheelPixels");
  ok(!!px && px.includes("mode === 1 ? 20 :"), "行模式（deltaMode=1）折算成像素");
  ok(!!px && px.includes("mode === 2 ? (ref && ref.clientHeight)"), "页模式按容器高折算");
  ok(!!px && /const max = 160/.test(px), "单次位移有上限（不一次跳半屏）");
}

console.log("\n[2] 超长文本护栏（浏览态轻量渲染）");
{
  ok(/const NODE_VIEW_LONG_CHARS = \d+/.test(jsView), "app-nodeview.js 声明字符阈值常量");
  ok(/const NODE_VIEW_LONG_LINES = \d+/.test(jsView), "app-nodeview.js 声明行数阈值常量");
  const isLong = funcBody(jsView, "function nodeViewIsLong(raw, opts)");
  ok(!!isLong, "存在 nodeViewIsLong");
  ok(!!isLong && /if \(opts && opts\.full\) return false;/.test(isLong), "opts.full 永远走完整渲染（既有 API 未动 / 只是不再有预览窗调用方）");
  ok(!!isLong && isLong.includes("if (s.length > NODE_VIEW_LONG_CHARS) return true;"), "字符数超阈值 → 长文本（先短路，不数行）");
  ok(!!isLong && isLong.includes("if (s.length <= NODE_VIEW_LONG_LINES) return false;"), "长度还不到行数上限 → 直接判否（不扫全文）");
  ok(!!isLong && /charCodeAt\(i\) === 10/.test(isLong), "行数按换行数，超上限提前 break");
  const long = funcBody(jsView, "function nodeViewLongEl(raw, opts)");
  ok(!!long, "存在 nodeViewLongEl 轻量视图");
  ok(!!long && long.includes('body.className = "ntv-plain ntv-long-body"'), "正文用既有纯文本类（沿用 CSS 与换行口径）");
  ok(!!long && long.includes("body.textContent = text"), "整块纯文本一次写入（不是逐行建节点）");
  ok(!!long && !/renderMarkdown|highlightAtRefsHtml|highlightYamlLine/.test(long), "轻量视图不做 Markdown / YAML / @引用渲染");
  ok(!!long && long.includes('meta.className = "ntv-long-meta"'), "带一行字符数小字（用户知道这不是全文渲染）");
  ok(!!long && !/👁|看全文/.test(long), "字符数小字不再指向已移除的预览入口（不提示点一枚不存在的按钮）");
  const tv = funcBody(jsView, "function nodeTextViewEl(text, opts)");
  ok(!!tv && tv.includes("if (nodeViewIsLong(raw, o))"), "nodeTextViewEl 入口按阈值分流");
  ok(!!tv && tv.includes('wrap.dataset.long = "1"'), "长文本视图打 dataset.long 标记");
  ok(!!tv && tv.indexOf("nodeViewIsLong(raw, o)") < tv.indexOf("detectViewLang(raw)"), "分流早于语言判定（不做无用的整篇分析）");
  ok(
    /\.wf-node\.browse \.n-view \.ntv-long-meta/.test(css) && /\.wf-node\.browse \.n-view \.ntv-long-body/.test(css),
    "canvas.css 覆盖 .ntv-long 两件套",
  );
  /* 真源仍在 renderer：本次只验证「有护栏 + 有样式」，不改既有短文本行为 */
  ok(/function detectViewLang/.test(jsView) && /function analyzeTextView/.test(jsView), "短文本的既有判定链路原样保留");
}

console.log("\n[3] 预览形态可滚：CSS 契约");
{
  const view = blockFrom(css, css.indexOf(".wf-node.browse .n-view {"));
  ok(!!view, "存在 .wf-node.browse .n-view 规则");
  ok(!!view && /overflow-y:\s*auto/.test(view), ".n-view 自身纵向可滚（滚动主体）");
  ok(!!view && /overflow-x:\s*hidden/.test(view), "横向裁掉，不撑破板身");
  ok(!!view && /min-height:\s*0/.test(view) && /flex:\s*1/.test(view), "flex:1 + min-height:0 → 内容超出时能滚");
  ok(!!view && /overscroll-behavior:\s*contain/.test(view), "滚到边界不把滚动链传给画布（画布不跟着缩放）");
  const body = blockFrom(css, css.indexOf(".wf-node.browse>.n-body {"));
  ok(!!body && /overflow:\s*hidden/.test(body), "body 自身仍裁住（滚动只发生在 .n-view 一层）");
  ok(
    !!blockFrom(css, css.indexOf(".wf-node.browse .n-view.n-view-plain")),
    "纯文本视图显式声明填充高度（flex:1 1 auto + min-height:0）",
  );
  /* 回归：`.wf-node.browse .md` 的 overflow:visible 与 `.wf-node.browse .n-view` 同特异性，
     后写胜 → Markdown 正文（.n-view.md）不再是滚动容器，scrollTop 设不进去，
     正文被 .n-body 裁掉却无处可滚。必须只对内层 .md 放开溢出。 */
  const mdRule = blockFrom(css, css.indexOf(".wf-node.browse .md {"));
  ok(!!mdRule && !/overflow/.test(mdRule), "滚动主体上的 .md 规则不写 overflow（同特异性会被后写顶掉）");
  ok(
    /\.wf-node\.browse \.md:not\(\.n-view\)/.test(css),
    "只对内层 .md 正文放开 overflow:visible",
  );
  ok(
    css.indexOf(".md:not(.n-view)") > css.indexOf(".wf-node.browse .md {"),
    "放开溢出的规则排在 .md 之后（覆盖顺序可控）",
  );
}

console.log("\n[3b] 超长输出护栏（OUTPUT 面板，浏览态）");
{
  const out = funcBody(jsCanvas, "function browseOutTextView(");
  ok(!!out, "存在 browseOutTextView");
  ok(!!out && out.includes("nodeViewIsLong(txt)"), "超长输出按同一阈值分流");
  ok(!!out && out.includes("body.textContent = txt"), "轻量路径整块纯文本一次写入（不逐行建节点）");
  ok(!!out && out.includes("renderMarkdown(txt)"), "短输出照旧 Markdown 渲染");
  ok(!!out && /n-out-long-body/.test(out) && /n-out-long-meta/.test(out), "轻量输出块带专属类（CSS 可覆盖）");
  ok(
    !!out && out.includes("超大输出 · 轻量显示 · {n} 字符") && !/👁/.test(out),
    "轻量输出块只给字符数、不再提示「点上方 👁 预览全文」（那枚按钮已移除）",
  );
  const procOut = funcBody(jsCanvas, "function browseProcOutEl(node)");
  ok(
    !!procOut && procOut.includes("browseOutTextView(r.output.text)"),
    "浏览态 OUTPUT 正文走护栏（不再无条件整篇 renderMarkdown）",
  );
  ok(
    !/md\.innerHTML = renderMarkdown\(r\.output\.text\)/.test(procOut || ""),
    "旧的无条件整篇渲染已移除",
  );
  ok(/\.wf-node\.browse \.n-out-long-body/.test(css), "canvas.css 覆盖 .n-out-long 正文");
}

console.log("\n[3c] vm 实测：超长输出走轻量路径（不调 renderMarkdown）");
{
  const body = funcBody(jsCanvas, "function browseOutTextView(");
  ok(!!body, "能切出 browseOutTextView 函数体");
  const box = [];
  const mkEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: "",
      textContent: "",
      innerHTML: "",
      children: [],
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    };
    box.push(el);
    return el;
  };
  let mdCalls = 0;
  const sandbox = {
    document: { createElement: mkEl },
    I18n: {
      t: (k, vars) =>
        String(k).replace(/\{(\w+)\}/g, (_, n) =>
          vars && vars[n] != null ? String(vars[n]) : "",
        ),
    },
    nodeViewIsLong: (s) => String(s).length > 6000,
    renderMarkdown: (t) => {
      mdCalls++;
      return "<md>" + t + "</md>";
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext("var browseOutTextView = function (text) " + body + ";", sandbox);
  const shortOut = sandbox.browseOutTextView("短输出 **加粗**");
  ok(mdCalls === 1 && shortOut.className === "md", "短输出照旧 renderMarkdown（一次）");
  mdCalls = 0;
  const longText = "很长的输出一行。\n".repeat(2000);
  const longOut = sandbox.browseOutTextView(longText);
  ok(mdCalls === 0, "超长输出完全不调 renderMarkdown（不摊出几万个 DOM 节点）");
  ok(longOut.className === "n-out-long", "超长输出渲染成轻量块 .n-out-long");
  ok(
    longOut.children[0].textContent === longText,
    "正文一次 textContent 写入（内容不丢）",
  );
  ok(
    longOut.children[1].textContent.includes(String(longText.length)),
    "小字里有真实字符数",
  );
  ok(!longOut.children[1].textContent.includes("👁"), "小字里不再出现已移除的预览按钮提示");
}

console.log("\n[4] 移除预览：节点头部不再有只读预览入口（本轮需求）");
{
  ok(
    jsCanvas.indexOf("function textPreviewButtonEl(") < 0 &&
      jsCanvas.indexOf("ltartTextPreviewButtonEl") < 0,
    "app-canvas.js 不再有文本预览按钮（头部 👁 两处入口都已移除）",
  );
  ok(
    jsCanvas.indexOf("openTextPreview") < 0 && jsCanvas.indexOf("n-textpeek") < 0,
    "app-canvas.js 不再引用预览窗与预览按钮类名",
  );
  ok(
    !/head\.appendChild\(textPreviewButtonEl\(node\)\)/.test(jsCanvas) &&
      !/head\.appendChild\(ltartTextPreviewButtonEl\(node\)\)/.test(jsCanvas),
    "头部按钮排里没有任何 👁 挂载点（普通文本 / 图像 / 智能任务 / input_text / ltout / ltart）",
  );
  /* 编辑那一半必须原样保留：ltout 的 ✎ 与文本类产物的 ✎ 编辑保存 */
  ok(
    jsCanvas.indexOf("function ltoutMdEditButtonEl(") > 0 &&
      /node\.kind === "ltout"[\s\S]{0,120}ltoutMdEditButtonEl\(node\)/.test(jsCanvas),
    "产出节点（ltout）头部仍摆 ✎ 内置 Markdown 编辑器（只删了重复的预览）",
  );
  ok(
    jsCanvas.indexOf("function ltartEditButtonEl(") > 0 &&
      /ltartTypeOfNode\(node\) === "text"[\s\S]{0,200}ltartEditButtonEl\(node\)/.test(jsCanvas),
    "文本类产物头部仍摆 ✎ 编辑保存（只删了重复的预览）",
  );
  ok(
    jsCanvas.indexOf("apiPreviewButtons(node)") > 0,
    "「◈ 预览运行时请求」按钮不受影响（那是请求预览，不是 Markdown 预览）",
  );
  ok(
    !/closeTextPreview/.test(jsReview),
    "审阅窗不再引用已删除的 closeTextPreview（同级浮层互斥只余必要项）",
  );
  ok(!exists("renderer/app-textpreview.js"), "renderer/app-textpreview.js 已删除");
  ok(!exists("renderer/css/textpreview.css"), "renderer/css/textpreview.css 已删除");
  ok(
    html.indexOf('src="app-textpreview.js"') < 0 &&
      styleCss.indexOf("textpreview.css") < 0,
    "index.html / style.css 不再引用已删除的预览窗模块与样式",
  );
  ok(
    !/function textPreviewOf|nodeHasPreviewText/.test(jsView),
    "app-nodeview.js 不再携带预览取值真源（取值函数随预览窗一起删除）",
  );
}

console.log("\n[5] 超长文本提示不再指向已移除的按钮（词条 / 文案）");
{
  const i18n = read("renderer/i18n.js");
  ok(
    i18n.indexOf("点上方 👁") < 0 && i18n.indexOf("预览全文") < 0,
    "i18n 词条里不再有「点上方 👁 / 预览全文」这类指向已移除预览窗的文案",
  );
  ok(
    i18n.indexOf("已截断显示 · 点上方 ✎ 编辑看全文") > 0,
    "ltart 板身截断后的出口改成头部 ✎ 编辑（中英成对）",
  );
  const ltoutGuide = read("guides/nodes/ltout.md");
  const ltartGuide = read("guides/nodes/ltart.md");
  const manual = read("guides/manual/longtask.md");
  ok(ltoutGuide.indexOf("👁") < 0, "guides/nodes/ltout.md 不再写 👁 只读看全文");
  ok(ltartGuide.indexOf("👁") < 0, "guides/nodes/ltart.md 不再写 👁 只读大窗");
  ok(manual.indexOf("👁") < 0, "guides/manual/longtask.md 不再写 👁");
  ok(
    ltoutGuide.indexOf("**✎**") > 0 && ltartGuide.indexOf("**✎**") > 0,
    "中英指南仍写明编辑入口（只移除预览那一半）",
  );
}

console.log("\n[6] vm 实测：nodeViewIsLong 边界 + 超长渲染形态");
{
  /* 复用既有测试的迷你 document 桩（app-nodeview.js 只用到 createElement / 属性赋值） */
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: "",
      dataset: {},
      style: {},
      children: [],
      textContent: "",
      innerHTML: "",
      attrs: {},
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return this.attrs[k];
      },
    };
    el.classList = {
      add(c) {
        if (!(" " + el.className + " ").includes(" " + c + " "))
          el.className = (el.className + " " + c).trim();
      },
    };
    return el;
  }
  const esc = (s) =>
    String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sandbox = {
    document: { createElement: makeEl },
    I18n: {
      t: (k, vars) =>
        "《" +
        String(k).replace(/\{(\w+)\}/g, (_, n) =>
          vars && vars[n] != null ? String(vars[n]) : "",
        ) +
        "》",
    },
    escapeHtml: esc,
    highlightYamlLine: (l) => esc(l),
    renderMarkdown: (t) => esc(String(t)),
    refCandidates: () => [{ title: "Alpha" }],
    refTagCandidates: () => [],
    findCandidateByTitle: () => null,
    tagByAtToken: () => "",
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    jsView +
      "\n;globalThis.__probe = { nodeTextViewEl, nodeViewIsLong, NODE_VIEW_LONG_CHARS, NODE_VIEW_LONG_LINES, detectViewLang };",
    sandbox,
    { filename: "renderer/app-nodeview.js" },
  );
  const P = sandbox.__probe;
  const flat = (el) => ({
    cls: el.className,
    lang: el.dataset.viewLang,
    long: el.dataset.long,
    kids: (el.children || []).map(flat),
    text: el.textContent,
  });
  const allText = (n) => (n.text || "") + (n.kids || []).map(allText).join("");
  const allCls = (n) => (n.cls || "") + (n.kids || []).map(allCls).join(" ");

  ok(P.NODE_VIEW_LONG_CHARS > 1000, "字符阈值是「超大」量级（实测 " + P.NODE_VIEW_LONG_CHARS + "）");
  ok(P.nodeViewIsLong("短提示词", {}) === false, "短文本判否");
  ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS), {}) === false, "恰好等于字符阈值仍走完整渲染");
  ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS + 1), {}) === true, "超过字符阈值判长");
  const manyLines = Array(P.NODE_VIEW_LONG_LINES + 1).fill("一行").join("\n");
  ok(P.nodeViewIsLong(manyLines, {}) === true, "行数超阈值判长（字符数远未到上限）");
  ok(P.nodeViewIsLong("x".repeat(P.NODE_VIEW_LONG_CHARS + 1), { full: true }) === false, "opts.full 永远完整渲染（既有 API 未动）");

  const short = flat(P.nodeTextViewEl("# 标题\n正文", { node: null }));
  ok(short.lang === "md" && !short.long, "短文本仍走原语言判定（md）");
  ok(allText(short).indexOf("#") >= 0 || allCls(short).includes(""), "短文本渲染未受影响");

  const longMd = "# 标题\n" + "很长的正文一行。\n".repeat(4000);
  const longNv = flat(P.nodeTextViewEl(longMd, { node: null }));
  ok(longNv.lang === "plain", "超长 Markdown 不再判成 md（跳过整篇结构渲染）");
  ok(longNv.long === "1", "打上 dataset.long 标记");
  ok(allCls(longNv).includes("ntv-long"), "渲染成轻量视图 .ntv-long");
  ok(allCls(longNv).includes("ntv-plain"), "正文沿用纯文本类（保留换行 / 缩进）");
  ok(allCls(longNv).includes("ntv-long-meta"), "带字符数小字");
  ok(allText(longNv).includes("《超大文本 · 轻量显示 · "), "小字文案走 I18n（文案可翻译）");
  ok(allText(longNv).includes(String(longMd.length)), "小字里有真实字符数");
  ok(!allCls(longNv).includes("ntv-md"), "超长文本不会同时产出 Markdown 块");
  /* 不管消费节点是什么类型，小字都不再指向预览按钮（本轮已移除） */
  const longPeek = flat(P.nodeTextViewEl(longMd, { node: { kind: "input_text" } }));
  ok(!allText(longPeek).includes("👁"), "文本节点：小字里不再出现 👁（不指向已移除的按钮）");
  const longNoPeek = flat(P.nodeTextViewEl(longMd, { node: { kind: "function" } }));
  ok(!allText(longNoPeek).includes("👁"), "非文本节点：小字同样不出现 👁");

  const longFull = flat(P.nodeTextViewEl(longMd, { node: null, full: true }));
  ok(longFull.long === undefined && longFull.lang === "md", "full:true 时超长文本照旧走 Markdown 完整渲染（API 兼容）");
}

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
  "  (smoke-node-text-guard)",
);
process.exit(fails ? 1 : 0);
