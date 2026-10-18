"use strict";
/* 输入框的 Markdown 预览档 —— 纯 Node 冒烟测试（不依赖 Electron · 不动源文件）
 *   node test/smoke-md-preview.js
 * 与 test/smoke-prompt-caret.js 同一套路：正则抽取源码 / CSS 来跑，不启动 Electron。
 *
 * 本轮需求（文本节点板身正文框 + 文本处理节点提示词框的 Markdown 渲染，共识逐条钉住）：
 *   [1] previewHtml 真实跑：常用块级 / 行内语法真出 HTML、表格与公式一并渲染
 *   [2] @ 引用 / @标签 / 内嵌图像胶囊与 Markdown 共存（PUA 占位符保护 + 注回高亮）
 *   [3] 安全纪律不变：先转义再解析，HTML 与危险链接都进不来
 *   [4] attach / apply 真跑（假 DOM）：切档、按钮文案、源码盒让位、重渲 —— 专抓
 *       「登记键名与读取键名不一致导致切档抛异常」这类只测 previewHtml 抓不到的缺陷
 *   [5] 框高不变（预览层 absolute 铺满、不参与排版；源码盒 visibility 让位不塌高）
 *   [6] 触发口径：唯一出口是那颗按钮（失焦不渲染、框内点击不切回）
 *   [7] 接入面收敛：只挂文本节点板身正文框与 proc_text 提示词框
 *   [8] 脚本装载顺序与词条
 *   [9] 预览开关只是界面态：不写节点、不进保存 */
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
const show = (v) => JSON.stringify(v);
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const hasNot = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);

/* ---------- 从源码里按名字抠出顶层函数 / 常量（与 smoke-prompt-caret.js 同口径） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
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
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "/" && p === "/") {
      const eol = src.indexOf("\n", j);
      j = eol < 0 ? src.length : eol;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体没有闭合：" + name);
}
/* 抠出一段容器（IIFE / 对象字面量）：从 startNeedle 之后第一个 { 起配平 */
function blockAfter(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error("找不到锚点：" + needle);
  const i = src.indexOf("{", at + needle.length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error("容器没有闭合：" + needle);
}

const appSrc = read("renderer/app.js");
const canvasSrc = read("renderer/app-canvas.js");
const modSrc = read("renderer/app-mdpreview.js");
const indexSrc = read("renderer/index.html");
const cssSrc = read("renderer/css/canvas.css");
const i18nSrc = read("renderer/i18n.js");

/* ═══════════ 在 VM 里跑真实的 previewHtml（app-mdpreview.js 原文 + app.js 真源依赖） ═══════════ */
const MOD = blockAfter(modSrc, "(function ()");
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
  I18n: {
    t: (s) => s,
  },
  /* app.js 的转义真源（模块只在 pillHtml 里用得到它；同名函数与 renderMatrix 同口径） */
  escapeHtml: (t) =>
    String(t == null ? "" : t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  /* 全站唯一渲染入口：真源；这里用与 app.js 完全相同的写法（先转义再 marked + breaks） */
  renderMarkdown: (t) => {
    const esc = String(t == null ? "" : t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    try {
      return sandbox.window.marked
        ? sandbox.window.marked.parse(esc, { gfm: true, breaks: true })
        : "<pre>" + esc + "</pre>";
    } catch (e) {
      throw e;
    }
  },
  /* @ 切词与判定：用 app.js 的真源（下面 extract 进上下文） */
  refCandidates: () => [
    { id: "nA", title: "素材甲" },
    { id: "nB", title: "文本节点 2" },
  ],
  refTagCandidates: () => ["资料"],
  promptCapsuleSupported: (n) => !!n && n.kind === "proc_text",
  promptCapsuleMap: (n) => {
    const m = new Map();
    for (const e of (n && n.inlineImgs) || []) m.set(String(e.id), e);
    return m;
  },
  mediaFileUrlOf: (p) => "file:///" + String(p || "").replace(/\\/g, "/"),
  fileName: (p) => String(p || "").split(/[\\/]/).pop(),
  PROMPT_CAP_SRC_LABELS: { paste: "粘贴", drop: "拖入", pick: "选择文件" },
  document: {
    createElement: () => ({
      className: "",
      textContent: "",
      title: "",
      setAttribute() {},
      getAttribute() {
        return "";
      },
      addEventListener() {},
      appendChild() {},
      classList: { toggle() {}, add() {}, remove() {} },
    }),
  },
  /* @ 切词真源（app.js）：与提示框高亮 / 运行期解析同源 */
  S: { wf: { nodes: [], wires: [], tagCatalog: ["资料"] } },
  documentRef: null,
  window: null,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
/* marked：直接用仓里的 vendor 版本（与运行时同一个解析器） */
sandbox.window.marked = require("../renderer/vendor/marked.min.js");
/* 胶囊 token 的正则真源在 app.js 里跨两行（位数由 PROMPT_CAP_ID_LEN 拼出来），fnBody 只取一行
   → 这里把那个常量表达式的右值原样抠出来，在注入位数的环境里求值（**等价改写用于测试环境**，
   真源一行未动；改位数时这里跟着常量走）。 */
const CAP_ID_LEN = Number((appSrc.match(/const PROMPT_CAP_ID_LEN = (\d+);/) || [])[1]);
if (!CAP_ID_LEN) throw new Error("读不到 PROMPT_CAP_ID_LEN（app.js 里的胶囊 id 位数）");
const CAP_EXPR = (function () {
  const m = appSrc.match(/const PROMPT_CAP_SRC_RE =\s*([\s\S]*?);\s*\n/);
  if (!m) throw new Error("读不到 PROMPT_CAP_SRC_RE 的右值");
  return m[1];
})();
const CAP_SRC_RE_LINE =
  "const PROMPT_CAP_SRC_RE = " +
  JSON.stringify(
    Function("PROMPT_CAP_ID_LEN", "return " + CAP_EXPR + ";").call(null, CAP_ID_LEN),
  ) +
  ";";

/* @ 切词真源（app.js）：与提示框高亮 / 运行期解析同源 */
vm.runInContext(
  [
    fnBody(appSrc, "atRefNamesFor"),
    fnBody(appSrc, "atMentionsOf"),
    fnBody(appSrc, "eachAtMention"),
    fnBody(appSrc, "findCandidateByTitle"),
    fnBody(appSrc, "tagByAtToken"),
    fnBody(appSrc, "normalizeTagName"),
    fnBody(appSrc, "wfTagCatalog"),
    fnBody(appSrc, "escapePromptHl"),
    fnBody(appSrc, "atRefNames"),
    fnBody(appSrc, "atRefSpanEnd"),
    fnBody(appSrc, "AT_REF_STOP"),
    fnBody(appSrc, "AT_REF_EDGE"),
    fnBody(appSrc, "AT_REF_WS_TEXT"),
    /* 胶囊 token 扫描用真源（正则 + 扫描函数），别用替身 —— 否则「认不出的 token
       原样保留」那条分支永远跑不到真代码 */
    CAP_SRC_RE_LINE,
    fnBody(appSrc, "promptCapsuleTokens"),
  ].join("\n"),
  sandbox,
  { filename: "md-preview-refs.js" },
);
ok(
  vm.runInContext(
    'promptCapsuleTokens("看图 @img:abc1234 说").length',
    sandbox,
  ) === 1,
  "胶囊 token 扫描真源在测试环境可用（" + CAP_ID_LEN + " 位定长 id 正则）",
);
/* 被测模块本体（原文，IIFE 会把出口挂到 sandbox.window 上） */
vm.runInContext(MOD, sandbox, { filename: "app-mdpreview.js" });
const P = sandbox.window.MTMdPreview;
ok(!!P && typeof P.html === "function", "模块出口 window.MTMdPreview.html 已就位（IIFE 真跑起来了）");
const H = (node, text) => P.html(node, text).html;

/* ===================== [1] 常用块级 / 行内语法真渲染 ===================== */
console.log("\n[1] previewHtml：行内 + 常用块级真出 HTML（含表格与公式）");
{
  const node = { id: "me", kind: "input_text" };
  const h1 = H(node, "# 标题一\n\n**粗** 与 *斜* 与 ~~删~~ 与 `码`\n");
  has(h1, "<h1", "标题出 <h1>");
  has(h1, "<strong>粗</strong>", "**粗体** 出 <strong>");
  has(h1, "<em>斜</em>", "*斜体* 出 <em>");
  has(h1, "<del>删</del>", "~~删除~~ 出 <del>");
  has(h1, "<code>码</code>", "`行内码` 出 <code>");
  const h2 = H(node, "- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用\n\n---\n");
  has(h2, "<ul>", "无序列表出 <ul>");
  has(h2, "<ol>", "有序列表出 <ol>");
  has(h2, "<li>甲</li>", "列表项出 <li>");
  has(h2, "<hr>", "分隔线出 <hr>");
  /* 引用块（`>`）：全站 renderMarkdown 的纪律是「先把 & < > " 转义，再交给 marked」，
     于是行首的 > 变成 &gt;、marked 不再当块标记 —— 这是**全站所有预览**从 v1 就有的行为
     （输出区 / 会话正文 / 手册 / 文件预览一致），本轮明确选择「完全沿用全站 renderMarkdown
     不另造第二套」，所以这里如实钉住：预览里它就是可见的字面量，而不是悄悄少渲染一块。 */
  has(h2, "&gt; 引用", "引用块按全站口径出字面量（先转义再解析的既有纪律，不是本轮漏渲染）");
  hasNot(h2, "<blockquote>", "与本轮「不另造渲染口径」的选择一致（要改这条得改全站 renderMarkdown）");
  const h3 = H(node, "```\nlet a = 1;\n```\n");
  has(h3, "<pre>", "代码块出 <pre>");
  has(h3, "<code", "代码块内含 <code>");
  const h4 = H(node, "[链接](https://example.com)\n");
  has(h4, 'href="https://example.com"', "链接出 <a href>");
  const h5 = H(node, "| a | b |\n| - | - |\n| 1 | 2 |\n");
  has(h5, "<table>", "表格渲染成真 <table>（用户选定：交给全站 renderMarkdown）");
  has(h5, "<td>1</td>", "表格单元格就位");
  const h6 = H(node, "公式 $x^2$\n");
  has(h6, "x^2", "公式按纯文本（或已渲染公式）保真呈现，不吞字符");
  const h7 = H(node, "第一行\n第二行\n");
  has(h7, "<br>", "breaks:true：单换行也换行（与全站预览同源）");
  ok(H(node, "") === "", "空正文 → 空 HTML（占位提示由 CSS 的 :empty 出，不在这里塞字）");
  ok(H(node, "   \n  ") === "", "只有空白 → 同样按空处理（与 textarea 的 placeholder 状态一致）");
}

/* ===================== [2] @ 引用 / @标签 / 胶囊与 Markdown 共存 ===================== */
console.log("\n[2] @ 引用 / @标签 / 内嵌图像胶囊：与 Markdown 共存（PUA 占位符 + 注回）");
{
  const node = { id: "me", kind: "proc_text", inlineImgs: [] };
  const h1 = H(node, "看 @素材甲 的图");
  has(h1, '<span class="at-ref-node">@素材甲</span>', "@标题 仍出青色高亮 span");
  const h2 = H(node, "看 @资料 的内容");
  has(h2, '<span class="at-ref-tag">@资料</span>', "@标签 仍出紫色高亮 span");
  const h3 = H(node, "看 @不存在 的内容");
  hasNot(h3, "<span", "不存在的 @词 不上高亮、也不吞字符");
  const h4 = H(node, "**@文本节点 2** 加粗");
  has(h4, "<strong>", "**@标题** 的粗体与 @ 同处一行时粗体仍在");
  has(h4, '<span class="at-ref-node">@文本节点 2</span>', "该行 @ 高亮也在（占位符方案的核心收益）");
  const h5 = H(node, "*跨行\n还是斜体* 与 @素材甲");
  has(h5, "<em>", "跨行强调照常生效");
  has(h5, '<span class="at-ref-node">@素材甲</span>', "同段里的 @ 引用不受强调影响");
  const h6 = H(node, "- @素材甲\n- @资料\n");
  has(h6, '<span class="at-ref-node">@素材甲</span>', "列表项里的 @ 高亮就位");
  has(h6, "<li>", "列表结构没有被高亮 span 破坏");
  /* 内嵌图像胶囊：只读小胶囊，不带 ✕（用户口径：预览态只读且不可点删） */
  const capNode = {
    id: "me",
    kind: "proc_text",
    inlineImgs: [{ id: "abc1234", path: "C:/data/assets/wf1/pc_a.png", name: "截图.png", src: "paste", at: 1 }],
  };
  const h7 = H(capNode, "看图 @img:abc1234 说说明");
  has(h7, 'class="n-md-pill"', "胶囊 token 在预览态出只读小胶囊");
  has(h7, "截图.png", "胶囊带文件名");
  hasNot(h7, "pc-del", "预览态胶囊没有 ✕（不可点删）");
  hasNot(h7, "@img:abc1234", "token 原文被胶囊替换掉（不再以源码形态露出）");
  const h8 = H(node, "看图 @img:zzzzzzz 说说明");
  has(h8, "@img:zzzzzzz", "登记表里认不出的 token 原样保留（绝不动用户正文）");
  /* 正文里出现 PUA 字符也不该被当成占位符吃掉 */
  const h9 = H(node, "原生 \uE000 字符");
  ok(!/at-ref/.test(h9), "正文里自带的 PUA 字符不会被误当成占位符注回");
}

/* ===================== [3] 安全纪律 ===================== */
console.log("\n[3] 先转义再解析：HTML 与危险链接进不来");
{
  const node = { id: "me", kind: "input_text" };
  const h1 = H(node, "<img src=x onerror=alert(1)>");
  has(h1, "&lt;img", "HTML 标签被转义（进不来）");
  hasNot(h1, "<img src=x", "没有原样注入的 <img>");
  const h2 = H(node, "<script>alert(1)</script>");
  hasNot(h2, "<script>", "没有原样注入的 <script>");
  const h3 = H(node, "@素材甲 <b>粗</b>");
  has(h3, '<span class="at-ref-node">@素材甲</span>', "@ 高亮与转义并存（注入不因占位符方案而打开）");
  has(h3, "&lt;b&gt;", "同一行里的 HTML 仍被转义");
}

/* ---------- 假 DOM：够模块的 attach / apply 真跑（只读测试用，不进产品代码） ----------
   为什么必须有这一段：只测 previewHtml 抓不到「切档时抛异常」这类缺陷 ——
   真机上出现过 rec.preview 与登记键名不一致（apply 里 reading 'classList' of undefined），
   previewHtml 全绿、界面却根本没反应。 */
function makeFakeDom() {
  function El(tag) {
    this.tagName = String(tag || "").toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.isConnected = true; /* 假 DOM：默认在文档里；测「重画」时手动置 false */
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.placeholder = "";
    this.scrollTop = 0;
    const self = this;
    this.classList = {
      add(c) {
        const set = String(self.className).split(/\s+/).filter(Boolean);
        if (set.indexOf(c) < 0) set.push(c);
        self.className = set.join(" ");
      },
      remove(c) {
        self.className = String(self.className)
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
      toggle(c, on) {
        if (on === undefined) on = String(self.className).split(/\s+/).indexOf(c) < 0;
        if (on) this.add(c);
        else this.remove(c);
        return !!on;
      },
      contains(c) {
        return String(self.className).split(/\s+/).indexOf(c) >= 0;
      },
    };
  }
  El.prototype.appendChild = function (c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  };
  El.prototype.setAttribute = function (k, v) {
    this.attrs[k] = String(v);
  };
  El.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  };
  El.prototype.removeAttribute = function (k) {
    delete this.attrs[k];
  };
  El.prototype.addEventListener = function (t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  };
  El.prototype.fire = function (t) {
    const ev = { type: t, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners[t] || []) fn.call(this, ev);
  };
  El.prototype.querySelector = function (sel) {
    const want = String(sel || "").replace(/^\./, "");
    const walk = (el) => {
      for (const c of el.children || []) {
        if (String(c.className).split(/\s+/).indexOf(want) >= 0) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  };
  const doc = {
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { doc, newEl: (t) => new El(t), api: { document: doc } };
}

/* ═══════════ attach / apply 真跑（假 DOM）═══════════ */
console.log("\n[4] attach / apply 真跑（假 DOM）：切档、按钮文案、源码盒让位、重渲都生效");
{
  const DOM = makeFakeDom();
  const S2 = Object.assign({}, sandbox, DOM.api);
  S2.window = null;
  vm.createContext(S2);
  S2.window = S2;
  S2.window.marked = sandbox.window.marked;
  S2.renderMarkdown = sandbox.renderMarkdown;
  vm.runInContext(
    [
      fnBody(appSrc, "atRefNamesFor"),
      fnBody(appSrc, "atMentionsOf"),
      fnBody(appSrc, "eachAtMention"),
      fnBody(appSrc, "findCandidateByTitle"),
      fnBody(appSrc, "tagByAtToken"),
      fnBody(appSrc, "normalizeTagName"),
      fnBody(appSrc, "wfTagCatalog"),
      fnBody(appSrc, "escapePromptHl"),
      fnBody(appSrc, "atRefNames"),
      fnBody(appSrc, "atRefSpanEnd"),
      fnBody(appSrc, "AT_REF_STOP"),
      fnBody(appSrc, "AT_REF_EDGE"),
      fnBody(appSrc, "AT_REF_WS_TEXT"),
      CAP_SRC_RE_LINE,
      fnBody(appSrc, "promptCapsuleTokens"),
    ].join("\n"),
    S2,
    { filename: "md-preview-refs-2.js" },
  );
  vm.runInContext(MOD, S2, { filename: "app-mdpreview-2.js" });
  const P2 = S2.window.MTMdPreview;
  const hostEl = DOM.newEl("div");
  hostEl.className = "n-prompt-wrap";
  const taEl = DOM.newEl("textarea");
  taEl.value = "# 标题\n\n**粗** 与 @素材甲\n";
  taEl.placeholder = "在此输入文本内容";
  hostEl.appendChild(taEl);
  let rec = null;
  let threw = "";
  try {
    rec = P2.attach(taEl, { id: "me", kind: "input_text" });
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  ok(!threw && !!rec, "attach 不抛异常并返回现场（" + (threw || "ok") + "）");
  const btn = hostEl.children.filter((c) => /n-md-toggle/.test(c.className))[0];
  const prev = hostEl.children.filter((c) => /n-md-prev/.test(c.className))[0];
  ok(!!btn && !!prev, "按钮与预览层都挂到了宿主上");
  ok(
    prev && prev.getAttribute("data-ph") === "在此输入文本内容",
    "预览层占位文案取自 textarea 的 placeholder",
  );
  ok(btn && btn.textContent === "预览", "编辑态按钮文案 = 预览");
  let e1 = "";
  try {
    btn.fire("click");
  } catch (e) {
    e1 = String((e && e.message) || e);
  }
  ok(!e1, "点按钮切到预览不抛异常（" + (e1 || "ok") + "）");
  ok(P2.isOn(taEl) === true, "档位状态 = 预览");
  ok(prev.className.indexOf("on") >= 0, "预览层真的显示出来（.on）");
  ok(prev.innerHTML.indexOf("<h1") >= 0, "预览层里是渲染后的 HTML（标题已出）");
  ok(
    prev.innerHTML.indexOf('<span class="at-ref-node">@素材甲</span>') >= 0,
    "预览层里的 @ 引用高亮就位",
  );
  ok(taEl.className.indexOf("n-md-src-hidden") >= 0, "源码盒让位（visibility:hidden，不塌高）");
  ok(btn.textContent === "编辑", "预览态按钮文案 = 编辑");
  ok(btn.getAttribute("aria-pressed") === "true", "aria-pressed 跟着档位走");
  let e2 = "";
  try {
    btn.fire("click");
  } catch (e) {
    e2 = String((e && e.message) || e);
  }
  ok(!e2, "从预览切回编辑不抛异常（" + (e2 || "ok") + "）");
  ok(P2.isOn(taEl) === false, "档位状态 = 编辑");
  ok(prev.className.indexOf("on") < 0 && prev.innerHTML === "", "预览层收起并清空内容");
  ok(taEl.className.indexOf("n-md-src-hidden") < 0, "源码盒恢复可编辑");
  ok(btn.textContent === "预览", "按钮文案回到预览");
  /* 编辑态改正文 → 再切预览必须重渲（不吃缓存），且回到顶部 */
  P2.toggle(taEl, true);
  const before = prev.innerHTML;
  ok(before.indexOf("粗</strong>") >= 0, "第一次预览内容就位（粗体真渲染）");
  P2.toggle(taEl, false);
  taEl.value = "改写后的 **新内容**\n";
  P2.toggle(taEl, true);
  ok(prev.innerHTML !== before, "正文改过后切回预览重渲（不是缓存的旧内容）");
  ok(prev.innerHTML.indexOf("新内容") >= 0, "新正文出现在预览里");
  ok(prev.scrollTop === 0, "每次重渲回到顶部");
  /* 范围：不支持的类型不挂、不留残余 */
  const host2 = DOM.newEl("div");
  const ta2 = DOM.newEl("textarea");
  host2.appendChild(ta2);
  ok(P2.attach(ta2, { id: "x", kind: "proc_image" }) === null, "非文本 / 文本处理节点不挂预览档");
  ok(
    host2.children.filter((c) => /n-md-/.test(c.className)).length === 0,
    "被拒的节点上没留下任何预览层或按钮",
  );
  /* ── 节点重画：textarea / 按钮 / 预览层整批换新（真机上「选中节点、改尺寸、运行」都会发生）
     旧引用当场作废 → 必须按宿主重新认，且档位回到编辑态，不能出现「点编辑反而开预览」。 ── */
  P2.toggle(taEl, true); /* 先切到预览态 */
  ok(P2.isOn(taEl) === true, "重画前处于预览态");
  /* 模拟重画：整颗宿主换新（旧元素全部脱离文档） */
  for (const el of [hostEl, taEl, btn, prev]) el.isConnected = false;
  const host3 = DOM.newEl("div");
  host3.className = "n-prompt-wrap";
  const ta3 = DOM.newEl("textarea");
  ta3.value = taEl.value;
  ta3.placeholder = "在此输入文本内容";
  host3.appendChild(ta3);
  P2.attach(ta3, { id: "me", kind: "input_text" });
  const btn3 = host3.children.filter((c) => /n-md-toggle/.test(c.className))[0];
  const prev3 = host3.children.filter((c) => /n-md-prev/.test(c.className))[0];
  ok(!!btn3 && !!prev3, "重画后新宿主上仍是「一套」预览层 + 按钮（没有叠第二套）");
  ok(
    host3.children.filter((c) => /n-md-toggle/.test(c.className)).length === 1,
    "同一颗宿主上只有一个开关按钮",
  );
  ok(btn3.textContent === "预览", "重画后按钮回到「预览」文案（档位不与视觉错位）");
  ok(prev3.className.indexOf("on") < 0, "重画后预览层是收起的");
  let e3 = "";
  try {
    btn3.fire("click");
  } catch (e) {
    e3 = String((e && e.message) || e);
  }
  ok(!e3, "重画后点新按钮不抛异常（" + (e3 || "ok") + "）");
  ok(P2.isOn(ta3) === true, "重画后点一下真的打开预览（不是「点编辑反开预览」那种错位）");
  ok(
    prev3.innerHTML.indexOf("新内容") >= 0,
    "重画后的预览层按新 textarea 的正文渲染（拿到 " + show(String(prev3.innerHTML).slice(0, 60)) + "）",
  );
  ok(
    host3.children.filter((c) => /n-md-prev/.test(c.className)).length === 1,
    "同一颗宿主上也只有一个预览层",
  );
}

/* ===================== [5] 框高不变 ===================== */
console.log("\n[5] 预览层不参与排版：框的宽高一律不变（含手动拖过尺寸的节点）");
{
  const prev = (cssSrc.match(/\.n-md-prev\s*\{[^}]*\}/) || [""])[0];
  ok(/position:\s*absolute/.test(prev), "预览层 position:absolute（不参与排版）");
  ok(/inset:\s*0/.test(prev), "预览层 inset:0（铺满输入框，尺寸跟着框走）");
  ok(/overflow/.test(prev) === false, "预览层不自己定 overflow（滚动交给同挂的 .md 的 overflow:auto）");
  has(cssSrc, ".n-md-prev.on:empty::before", "空内容用 :empty 出占位（有内容自动消失，不叠字）");
  has(cssSrc, "content: attr(data-ph)", "占位文案取自 textarea 自己的 placeholder（两态同源）");
  /* 板身那层定位宿主随「文本节点右上角预览开关」一起移除：CSS 里不应再有 .n-md-wrap
     （正文框重新直接铺在 .n-body 里，flex:1 的那份尺寸口径由 .n-text 自己给）。 */
  ok(
    !/\.n-md-wrap\s*\{/.test(cssSrc),
    "文本节点那颗开关移除后不再留 .n-md-wrap 定位宿主样式",
  );
  const hid = (cssSrc.match(/\.n-md-src-hidden\s*\{[^}]*\}/) || [""])[0];
  ok(/visibility:\s*hidden/.test(hid), "预览态源码盒 visibility:hidden 让位（display:none 会让包裹层塌成 0 高，框就变矮了）");
  hasNot(hid, "display: none", "源码盒不退出排版");
  has(
    modSrc,
    'rec.ta.classList.toggle("n-md-src-hidden", on)',
    "切换时真给源码盒挂上让位类",
  );
  const toggle = (cssSrc.match(/\.n-md-toggle\s*\{[^}]*\}/) || [""])[0];
  ok(/position:\s*absolute/.test(toggle), "开关按钮也 absolute（不占版面、不挤框）");
  ok(/z-index:\s*5/.test(toggle), "按钮 z-index 高于预览层与胶囊（不会被盖住点不到）");
  ok(/z-index:\s*3/.test(prev), "预览层 z-index 高于编辑态镜像层与胶囊（盖住 @ 高亮与 .pc-pill）");
  /* 预览层里的 @ 高亮必须自带配色：编辑态那两条只作用在 .n-prompt-hl 上，
     类名在预览层里照样没有颜色 = 用户看到的「预览里 @ 没高亮」（真机抓到过）。
     选择器自「失焦浏览态也按 Markdown 渲染」那一轮起是**逗号并排**的两条
     （.n-md-prev + .n-md-browse，同一份色值），所以匹配时允许逗号列表，规则体照旧。 */
  const nodeRule = (cssSrc.match(/\.n-md-prev\s+\.at-ref-node[^{]*\{[^}]*\}/) || [""])[0];
  const tagRule = (cssSrc.match(/\.n-md-prev\s+\.at-ref-tag[^{]*\{[^}]*\}/) || [""])[0];
  ok(/color:\s*var\(--cyan\)/.test(nodeRule), "预览层里 @节点 引用自带青色（与编辑态同色）");
  ok(/#e0a0ff/.test(tagRule), "预览层里 @标签 引用自带紫色（与编辑态同色）");
  ok(
    /\.n-md-browse\s+\.at-ref-node/.test(nodeRule) && /\.n-md-browse\s+\.at-ref-tag/.test(tagRule),
    "同一份色值也盖住失焦浏览态的预览块（.n-md-browse，两处不会各自漂色）",
  );
  const pillRule = (cssSrc.match(/\.n-md-prev\s+\.n-md-pill[^{]*\{[^}]*\}/) || [""])[0];
  ok(/\.n-md-browse\s+\.n-md-pill/.test(pillRule), "内嵌图像胶囊样式同样与浏览态预览块共用");
}

/* ===================== [5] 触发口径 ===================== */
console.log("\n[6] 唯一出口是那颗按钮：失焦不渲染、框内点击不切回");
{
  const on = blockAfter(modSrc, "(function ()");
  has(on, 'btn.addEventListener("click"', "按钮点击切换档位");
  hasNot(on, 'btn.addEventListener("focus"', "没有 focus 触发");
  hasNot(on, 'addEventListener("blur"', "没有 blur（失焦）触发");
  hasNot(on, 'ta.addEventListener("click"', "框内点击不切回编辑（只有按钮这一条出口）");
  has(on, "render(rec)", "切到预览时调 render() 重渲当前正文（每次切档都重渲，不缓存）");
  has(on, "rec.preview.scrollTop = 0", "每次重渲回到顶部（不缓存上次的滚动位置）");
  has(on, 'prev.setAttribute("aria-hidden", "true")', "预览层对读屏器隐藏（它是只读镜像，不是第二份内容）");
  has(on, "supported(node)", "档位只在允许的节点类型上挂");
  /* 只读面与胶囊口径 */
  has(on, 'node.kind === "input_text" || node.kind === "proc_text"', "范围判据 = 文本节点 + 文本处理节点");
  has(modSrc, "promptCapsuleSupported(node)", "胶囊按既有判定（同一份真源，不另立标准）");
}

/* ===================== [6] 接入面收敛 ===================== */
console.log("\n[7] 只剩一处：proc_text 提示词框（文本节点板身那颗开关已按用户要求移除）");
{
  /* mountPromptTextarea 是 proc_text / proc_image / agent_task 共用的：范围判据必须写在这里 */
  const mount = fnBody(appSrc, "mountPromptTextarea");
  has(mount, 'node.kind === "proc_text"', "提示词框入口限定 proc_text（judge / agent_task 不在本轮范围）");
  has(mount, "MTMdPreview.attach(ta, node)", "提示词框真的接上了预览档");
  /* 板身：文本节点右上角那颗「预览」压在正文上挡字 —— 已按用户要求移除，
     连预览层 / 定位宿主 / 输入时的 refresh 一起撤掉（失焦浏览态的正文渲染另走一条路）。 */
  const body = fnBody(canvasSrc, "buildBody");
  hasNot(body, "MTMdPreview.attach", "文本节点板身正文框不再挂预览档（那颗按钮会挡字）");
  hasNot(body, 'className = "n-md-wrap"', "板身不再套定位宿主（正文框直接铺在 .n-body 里）");
  ok(
    (canvasSrc.match(/MTMdPreview\.attach\(/g) || []).length === 0,
    "app-canvas.js 里一次 attach 调用都没有",
  );
  ok(
    (appSrc.match(/MTMdPreview\.attach\(/g) || []).length === 1,
    "app.js 里只有一处 attach 调用",
  );
  /* 只读展示分支不得接入：那几处是 node.ro / inputInherited 的只读 textarea */
  ok(
    !/readOnly = true;[\s\S]{0,400}MTMdPreview/.test(canvasSrc),
    "只读展示框（readOnly=true）附近没有接入预览档",
  );
  /* 重画之后必须把现场搬回当前这一帧（否则点「编辑」反而开预览：这就是真机抓到的缺陷） */
  has(
    appSrc,
    "MTMdPreview.refresh(ta);",
    "提示词框侧：每次同步顺带把现场搬回当前 DOM（syncPromptRefBackdrop 末尾）",
  );
  hasNot(
    canvasSrc,
    "MTMdPreview.refresh(ta);",
    "板身侧不再刷新预览（那条路连同按钮一起撤掉了）",
  );
  has(
    modSrc,
    'host.querySelector(".n-md-toggle")',
    "按宿主重新认按钮 / 预览层 / textarea（宿主被重画就整份作废）",
  );
  has(modSrc, "rec.on = false;", "重画后档位回到编辑态（宁可再点一次，也不给错位的档位）");
}

/* ===================== [7] 装载与接线 ===================== */
console.log("\n[8] 脚本装载顺序与词条");
{
  has(indexSrc, '<script src="app-mdpreview.js"></script>', "index.html 已装载新模块");
  const iMod = indexSrc.indexOf('<script src="app-mdpreview.js"></script>');
  const iMain = indexSrc.indexOf('<script src="app.js"></script>');
  /* 装载顺序的真正约束（实测踩过）：浏览态那一屏（失焦时的 Markdown 预览块）是**启动装载期**
     就渲染出来的（app-boot.js 拉起工作流的第一遍渲染），而 applyNodeForm 只在形态真的变了时
     才重建 body —— 本模块若晚于那一遍就位，首屏文本节点会永远停在纯文本回落形态上
     （现象：重启应用后未选中的正文仍是原文本，点一下选中再取消才变）。所以它必须排在
     app-canvas.js 与 app-boot.js 之前；而它取 app.js 的 renderMarkdown / refCandidates 全在
     调用期，排在 app.js 之后即可。回归断言同时写在 test/smoke-md-outline.js [9] 末。 */
  const iCanvas = indexSrc.indexOf('<script src="app-canvas.js"></script>');
  const iBoot = indexSrc.indexOf('<script src="app-boot.js"></script>');
  ok(iCanvas >= 0 && iMod < iCanvas, "排在 app-canvas.js 之前（浏览态渲染调用期就取得到）");
  ok(iBoot >= 0 && iMod < iBoot, "排在 app-boot.js 之前（首遍装载渲染时已在位）");
  ok(iMain >= 0 && iMod > iMain, "排在 app.js 之后（调用期取它的 renderMarkdown / refCandidates）");
  ok(indexSrc.split("app-mdpreview.js").length === 3, "只装载一次（另一处是注释里的文件名）");
  has(
    read("renderer/i18n.js"),
    '"Markdown 预览 / 回到编辑"',
    "新增词条已进 i18n（中英两栏）",
  );
}

/* ===================== [8] 只是界面态 ===================== */
console.log("\n[9] 预览开关不写节点、不进保存");
{
  const on = blockAfter(modSrc, "(function ()");
  ok(!/scheduleSave|pushHistory|clearDownstream/.test(on), "切换档位不触发保存 / 撤销 / 清下游");
  ok(!/node\.(text|prompt|task)\s*=/.test(on), "切换档位不写节点正文（textarea 始终是唯一真源）");
  ok(!/api\.[a-zA-Z]+\(/.test(on), "不调任何主进程接口（纯界面态）");
}

/* ===================== [9] 预览与编辑态观感对齐 ===================== */
console.log("\n[10] 预览两面与编辑框逐条对齐（用户口径：编辑时的观感更好）");
{
  /* .n-text 是两处输入框共用的编辑态基样式（文本节点板身正文框 + proc_text 提示词框），
     它就是「编辑时的观感」唯一真值；预览两面必须照抄它，不是各写各的。 */
  const nText = ruleWith(cssSrc, "\n.n-text");
  ok(/font-family:\s*var\(--mono\)/.test(nText), "编辑态字体 = 等宽 var(--mono)（基准）");
  ok(/font-size:\s*12\.5px/.test(nText), "编辑态字号 12.5px（基准）");
  ok(/line-height:\s*1\.5/.test(nText), "编辑态行高 1.5（基准）");
  ok(/padding:\s*6px/.test(nText), "编辑态内边距 6px（基准）");
  has(read("renderer/css/base.css"), "box-sizing: border-box", "全局 border-box（两边 6px 内边距是同一处正文起点）");

  /* 取规则体：传**纯选择器文本**（不带结尾的 `{`），函数自己找它后面第一个 `{` 起算，
     再按花括号配平取第一条规则，返回 "选择器{规则体}"。
     源文件是 CRLF，先把 \r 归一掉：本函数里的选择器串一律按 \n 写，与平台无关。
     注释里也提到选择器时用 `\n` 前缀把匹配钉在行首（注释是缩进行，不会误命中）。
     `exact`：多选择器共用一条规则时（h1,h2,h3,h4 同一条），要取「单条独立规则」就得
     显式打开 —— 否则 needle 会落在共用表上、拿到共用的那条（值当然对不上）。 */
  function ruleWith(src, sel, exact) {
    const s = src.split("\r\n").join("\n");
    let at = -1;
    for (let from = 0; ; ) {
      const i = s.indexOf(sel, from);
      if (i < 0) break;
      const open = s.indexOf("{", i + sel.length);
      if (open >= 0 && (!exact || /^\s*\{/.test(s.slice(i + sel.length, open + 1)))) {
        at = i;
        break;
      }
      from = i + 1;
    }
    if (at < 0) return "";
    const open = s.indexOf("{", at + sel.length);
    if (open < 0) return "";
    const start = s.lastIndexOf("}", open) + 1;
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) return s.slice(start, j + 1);
      }
    }
    return s.slice(start);
  }

  /* ---- 编辑态那颗「预览」档（.n-md-prev）---- */
  const prev = ruleWith(cssSrc, "\n.n-md-prev");
  ok(/font-family:\s*var\(--mono\)/.test(prev), "预览档字体 = 编辑态同一份等宽（切档字面不跳）");
  ok(/font-size:\s*12\.5px/.test(prev), "预览档字号 = 编辑态 12.5px");
  ok(/line-height:\s*1\.5/.test(prev), "预览档行高 = 编辑态 1.5");
  ok(
    /padding:\s*6px/.test(prev) && /border:\s*1px solid transparent/.test(prev),
    "预览档盒模型 = 编辑态（1px 边框 + 6px 内边距）",
  );
  has(cssSrc, ".n-md-prev>p+p", "预览档：相邻段落只留一档块间距（不照抄 .md 的 5px 段间距）");
  ok(
    ruleWith(cssSrc, "\n.n-md-prev h1", true).indexOf("font-size: 14px") >= 0 &&
      ruleWith(cssSrc, "\n.n-md-prev h2", true).indexOf("font-size: 13px") >= 0,
    "预览档标题按正文基准微放大（h1 14 / h2 13）",
  );
  const prevH = ruleWith(cssSrc, "\n.n-md-prev h4");
  ok(/line-height:\s*1\.5/.test(prevH), "预览档标题行高与正文同级（标题不再把行位撑开）");
  const prevLi = ruleWith(cssSrc, "\n.n-md-prev li");
  ok(/margin:\s*0/.test(prevLi), "预览档列表项之间不再额外撑开");

  /* ---- 失焦浏览态的预览块（.n-md-browse）----
     取**基准那条**（exact：选择器后面紧跟 `{`）—— 文本节点那一面另有一条
     `.n-md-browse-txt` 覆盖行高（1.7，用户口径「预览行间距太小」），
     不带 exact 会先命中那条覆盖规则，把基准的字号 / 内边距 / 边框一起判错。 */
  const browse = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse", true);
  ok(/font-family:\s*var\(--mono\)/.test(browse), "浏览态预览块字体 = 编辑态同一份等宽");
  ok(/font-size:\s*12\.5px/.test(browse), "浏览态预览块字号 = 编辑态 12.5px");
  ok(/line-height:\s*1\.5/.test(browse), "浏览态预览块行高 = 编辑态 1.5（文本节点那面由 .n-md-browse-txt 提到 1.7）");
  ok(/padding:\s*6px/.test(browse), "浏览态预览块内边距 = 编辑态 6px（上一轮那份 4px 0 6px 已作废）");
  const browseTxt = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse.n-md-browse-txt", true);
  ok(/line-height:\s*1\.7/.test(browseTxt), "文本节点浏览态预览行高 1.7（用户口径：预览行间距太小）");
  /* 编辑框的正文左起点 = 1px 边框 + 6px 内边距；浏览态这块没有边框时要靠 1px 透明边框占位，
     否则整块正文比编辑态左移 1px、上移 1px（真机量过：无边框时 h1 落在 +6，编辑框是 +7）。 */
  ok(
    /border:\s*1px solid transparent/.test(browse),
    "浏览态预览块用 1px 透明边框占住编辑框那 1px，正文左起点 / 首行顶边与编辑态同像素",
  );
  hasNot(cssSrc, "4px 0 6px", "旧「阅读面放宽」的块内边距写法已不存在");
  const browseBase = ruleWith(cssSrc, "\n.wf-node.browse .n-view");
  hasNot(browseBase, "line-height: 1.75", "旧 1.75 行距写法已不存在（.n-view 基准也不再放宽）");
  has(
    cssSrc,
    ".wf-node.browse .md.n-md-browse>.ntv-md>p+p",
    "浏览态预览块：块间距口径与预览档同值（选择器要穿过 .ntv-md 那层壳，否则一条都不命中）",
  );
  ok(
    ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse h1", true).indexOf("font-size: 14px") >= 0 &&
      ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse h2", true).indexOf("font-size: 13px") >= 0,
    "浏览态预览块标题同样是 h1 14 / h2 13 的微放大",
  );
  const browseLi = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse li");
  ok(/margin:\s*0/.test(browseLi), "浏览态预览块列表项之间不再额外撑开（旧 3px 已作废）");
  hasNot(cssSrc, "margin: 3px 0", "旧的列表项 3px 撑开写法已不存在");

  /* ---- 范围收敛：改的只是这两面，别的 Markdown 面（输出区 / 手册 / 其它节点）原口径不动 ---- */
  const mdBase = ruleWith(cssSrc, "\n.md");
  ok(
    /line-height:\s*1\.7/.test(mdBase) && /font-size:\s*12px/.test(mdBase),
    "全站 .md 基准口径未动（输出区 / 手册仍是原来的阅读排版）",
  );
  /* 两面的共用规则：CSS 源是 CRLF，断言前先归一换行，选择器串按 \n 写 */
  const cssN = cssSrc.split("\r\n").join("\n");
  ok(
    /\.n-md-prev \.at-ref-node,\n\.n-md-browse \.at-ref-node \{/.test(cssN),
    "两面的 @节点引用高亮仍是同一条逗号选择器（同一份色值，不会各自漂）",
  );
  ok(
    /\.n-md-prev \.at-ref-tag,\n\.n-md-browse \.at-ref-tag \{/.test(cssN),
    "两面的 @标签引用高亮同样是同一条逗号选择器",
  );
  ok(
    /\.n-md-prev \.n-md-pill,\n\.n-md-browse \.n-md-pill \{/.test(cssN),
    "两面的内嵌图像胶囊样式同源",
  );
  /* 标题级差两处各一份（宿主类名不同没法合成一条），这里逐条核两面写的是同一组数值 */
  const prevH1 = ruleWith(cssSrc, "\n.n-md-prev h1", true);
  const browseH1 = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse h1", true);
  ok(
    /font-size:\s*14px/.test(prevH1) && /font-size:\s*14px/.test(browseH1),
    "h1 14px 两面同值",
  );
  /* h3 / h4 是「同一档字号写一条共用选择器」（h3, h4 { font-size: 12.5px }），
     所以这里取共用规则体、按选择器表核它确实把 h3 与 h4 都串进去了。 */
  const prevH34 = ruleWith(cssSrc, "\n.n-md-prev h3");
  const browseH34 = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse h3");
  ok(
    /\.n-md-prev h3,\n\.n-md-prev h4\s*\{/.test(prevH34) &&
      /\.n-md-prev h4,\n\.n-md-prev h3\s*\{/.test(prevH34) === false &&
      /\.wf-node\.browse \.md\.n-md-browse h3,\n\.wf-node\.browse \.md\.n-md-browse h4\s*\{/.test(
        browseH34,
      ),
    "h3 / h4 共写一条 = 正文同号 12.5px，两面同值",
  );
  const prevCode = ruleWith(cssSrc, "\n.n-md-prev pre code");
  const browseCode = ruleWith(cssSrc, "\n.wf-node.browse .md.n-md-browse pre code");
  ok(
    /font-size:\s*12\.5px/.test(prevCode) && /font-size:\s*12\.5px/.test(browseCode),
    "代码块字号提到正文同档 12.5px，两面同值",
  );
  ok(
    /正文左起点/.test(cssSrc) && /1px 透明边框/.test(cssSrc) || /盒模型与 \.n-text/.test(cssSrc),
    "两面的盒模型换算在 CSS 注释里写明（1px 透明边框 + 6px 内边距 = 编辑框内容盒起点）",
  );
}

console.log(
  "\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"),
);
process.exit(fails ? 1 : 0);
