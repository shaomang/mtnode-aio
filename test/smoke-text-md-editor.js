"use strict";
/* 文本节点的 Markdown 编辑器（renderer/app-textedit.js · 节点头部 ✎ 入口）：
 *   node test/smoke-text-md-editor.js
 * 钉住的口径：
 *   [1] 入口：可编辑的文本节点（kind=input_text · 非只读 / 非继承 / 非拆分）才给编辑器；
 *       节点头部那枚 ✎（.n-md-edit）已接线到 openTextNodeEditor，节点板身 textarea 原样保留；
 *   [2] 窗口：近全屏（css/textedit.css 的 .txmd-box）、右下可拖调、最小宽 ≥ 50% 视口，
 *       另有放大 / 还原按钮；关闭走显式路径（✕ / Esc / 底部按钮），点外部不关；
 *   [3] 正文：所见即所得（contenteditable #textEditRich）+ 可切源码（#textEditSrc）；
 *       正文 ⇄ Markdown 与「✎ AI 审阅」同源（app-review.js 的 mdToRichHtml / richToMarkdown）；
 *   [4] 工具栏：与审阅同级（标题 / 粗斜删 / 引用 / 列表 / 待办 / 链接 / 行内码 / 代码块 /
 *       图片 / 表格 / 公式 / 撤销重做），方形 .rv-tool 按钮；
 *   [5] 批注与 AI 修订：全文批注 + 拖选→右侧浮空便笺的局部批注；首个批注后顶部出现
 *       「让 AI 依据批注修订」；提示词走 app-review.js 的 buildRevisionPrompt（当前全文 +
 *       历史全部批注），服务商按「节点 providerId → 任一可用文本服务商」回退；
 *   [6] 数据：版本链 / 批注与 node.review 共用同一份，保存只写 node.text（不写 node.output），
 *       关窗有未保存改动先确认；
 *   [6b] 双向同步：节点板身 textarea 直接输入的内容在开窗时拉进当前版（不被旧版本链压住）、
 *       编辑器里的改动随时写回 node.text 与板身 textarea、编辑器开着时板身只读并给提示、
 *       别的路径改了 node.text 由轮询拉回；
 *   [7] 插图：落盘到画布工作目录的 assets/（相对引用）；没有工作目录就走画布工作目录闸门；
 *   [8] 接线：index.html 脚本位（app-review.js 之后）、style.css @import、中英词条齐备。
 */
const fs = require("fs");
const VM = require("vm");
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
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  let depth = 0;
  let started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") {
      depth++;
      started = true;
    } else if (c === "}") {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

const MOD = read("renderer/app-textedit.js");
const CSS = read("renderer/css/textedit.css");
const CANVAS = read("renderer/app-canvas.js");
const REVIEW = read("renderer/app-review.js");
const HTML = read("renderer/index.html");
const STYLE = read("renderer/style.css");
const I18N = read("renderer/i18n.js");

/* ═══════════ 极简 DOM 桩：够 app-textedit.js 真跑「打开 → 渲染 → 保存」一遍 ═══════════ */
function mkClassList(el) {
  const api = {
    add: (c) => {
      const s = el._cls.split(" ").filter(Boolean);
      if (s.indexOf(c) < 0) s.push(c);
      el._cls = s.join(" ");
    },
    remove: (c) => {
      el._cls = el._cls
        .split(" ")
        .filter((x) => x && x !== c)
        .join(" ");
    },
    contains: (c) => el._cls.split(" ").indexOf(c) >= 0,
    toggle: (c, on) => (on ? api.add(c) : api.remove(c)),
  };
  return api;
}
let idSeq = 0;
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    _cls: "",
    children: [],
    attrs: {},
    style: {},
    hidden: false,
    value: "",
    readOnly: false,
    textContent: "",
    title: "",
    type: "",
    spellcheck: true,
    contentEditable: "inherit",
    _handlers: {},
    _parser: null,
    _qcache: null,
    appendChild(c) {
      if (c && c._frag) {
        for (const k of c.children) el.children.push(k);
        return c;
      }
      el.children.push(c);
      if (c) {
        c._parentShell = el;
        c.parentNode = el;
      }
      if (c && c.id) el._byId[c.id] = c;
      return c;
    },
    insertBefore(c, ref) {
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i >= 0) el.children.splice(i, 0, c);
      else el.children.push(c);
      if (c && c.id) el._byId[c.id] = c;
      if (c) { c._parentShell = el; c.parentNode = el; }
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) { c._parentShell = null; c.parentNode = null; }
      return c;
    },
    contains(n) {
      if (!n) return false;
      if (n === el) return true;
      for (const c of el.children || []) if (c.contains && c.contains(n)) return true;
      return false;
    },
    append(...cs) {
      for (const c of cs) el.appendChild(c);
      return el;
    },
    addEventListener(t, f) {
      (el._handlers[t] = el._handlers[t] || []).push(f);
    },
    removeEventListener() {},
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    focus() {},
    querySelector(sel) {
      return stubQS(el, sel);
    },
    querySelectorAll(sel) {
      const s = String(sel);
      const parts = /^\.([\w-]+)\[([\w-]+)\]$/.exec(s);
      return stubAll().filter(
        (n) =>
          (!parts || n.classList.contains(parts[1])) &&
          (!parts || n.getAttribute(parts[2].toLowerCase()) != null),
      );
    },
    getBoundingClientRect() {
      return { width: 1600, height: 1000, top: 0, left: 0, bottom: 1000, right: 1600 };
    },
    _byId: Object.create(null),
    _parentShell: null,
  };
  el.classList = mkClassList(el);
  Object.defineProperty(el, "className", {
    get() {
      return el._cls;
    },
    set(v) {
      el._cls = String(v || "");
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._html || "";
    },
    set(v) {
      el._html = String(v || "");
      el.children = [];
      el._byId = Object.create(null);
      el._parser = null;
      el._qcache = null;
      if (!el._html) return;
      el._parser = makeHtmlParser(el, el._html);
      for (const ch of el._parser.roots) el.appendChild(ch);
    },
  });
  Object.defineProperty(el, "firstChild", {
    get() {
      return el.children[0] || null;
    },
  });
  Object.defineProperty(el, "childNodes", {
    get() {
      return el.children;
    },
  });
  return el;
}
/* ═══ 桩的「规范化解析」：DOM 一变就按当前树重建 id / class 索引 ═══
 * 目的只有一个：同一个 id / 同一个选择器，每次必须返回同一个桩对象。
 * 树一变（innerHTML 重设 / 增删节点）就 bump，旧索引整体作废，否则测试拿到的
 * 会是已被摘下来的孤儿节点，改它等于没改。
 */
let stubEpoch = 0;
/* 节点一变就 bump（只为「树变过没有」留个号）；索引一律现算，绝不缓存对象，
   否则重渲染后缓存里留着的是已被摘下来的孤儿节点，改它等于没改。 */
function stubBump() {
  stubEpoch++;
}
/* 现算的 id 索引（按文档序，后出现的覆盖先出现的，与浏览器一致） */
function stubIdMap() {
  const ids = Object.create(null);
  for (const el of stubAll()) if (el.id) ids[el.id] = el;
  return ids;
}
/* 当前树上所有节点（doc.body 在末尾追加，方便按文档序取「第一个」） */
function stubAll() {
  const all = [];
  const walk = (n) => {
    all.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(doc.body);
  return all;
}
/* 极简 HTML 解析：只认 <tag id class ...> 的嵌套结构（够宿主壳用），文本一律丢 */
function makeHtmlParser(host, html) {
  const tagRe = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;
  const roots = [];
  const stack = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === "/";
    const tag = m[2];
    const attrs = m[3] || "";
    const selfClose = m[4] === "/" || ["br", "hr", "input", "img"].indexOf(tag.toLowerCase()) >= 0;
    if (closing) {
      stack.pop();
      continue;
    }
    const el = mkEl(tag);
    const idM = /\sid="([^"]*)"/.exec(attrs);
    if (idM) el.id = idM[1];
    const clsM = /\sclass="([^"]*)"/.exec(attrs);
    if (clsM) el.className = clsM[1];
    const dataM = /\sdata-mode="([^"]*)"/.exec(attrs);
    if (dataM) el.attrs["data-mode"] = dataM[1];
    if (stack.length) stack[stack.length - 1].appendChild(el);
    else roots.push(el);
    if (!selfClose) stack.push(el);
  }
  const all = [];
  const walk = (n) => {
    all.push(n);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  const parseSel = (sel) => {
    const s = String(sel || "").trim();
    if (!s) return null;
    const simple = (one) => {
      if (one.charAt(0) === "#") return all.find((n) => n.id === one.slice(1)) || null;
      if (one.charAt(0) === ".") {
        const cls = one.slice(1).split(".").filter(Boolean);
        return (
          all.find((n) => cls.every((c) => n.classList.contains(c))) || null
        );
      }
      if (one.charAt(0) === "[") {
        const k = one.slice(1, -1);
        return all.find((n) => n.getAttribute(k) != null) || null;
      }
      return all.find((n) => n.tagName === one.toUpperCase()) || null;
    };
    /* 只支持「后代选择器」的最后一段定位（够用：宿主壳里的选择器都是 .rv-tab / #id 之类） */
    const parts = s.split(/\s+/).filter(Boolean);
    return simple(parts[parts.length - 1]);
  };
  return { roots: roots, all: all, sel: parseSel };
}
function hostQuery(host, sel) {
  const parts = String(sel || "").split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  const search = (n) => {
    if (matchSimple(n, last)) {
      /* 有祖先条件时要求祖先链也匹配（从右往左逐段核对） */
      let okAll = true;
      let cur = n;
      for (let i = parts.length - 2; i >= 0 && okAll; i--) {
        let p = cur && cur._parentShell;
        let hit = false;
        while (p) {
          if (matchSimple(p, parts[i])) {
            hit = true;
            break;
          }
          p = p._parentShell;
        }
        if (!hit) okAll = false;
        cur = p || cur;
      }
      return okAll ? n : null;
    }
    for (const c of n.children || []) {
      const r = search(c);
      if (r) return r;
    }
    return null;
  };
  for (const r of host.children || []) {
    const hit = search(r);
    if (hit) return hit;
  }
  return null;
}
/* doc 级 querySelector：与元素级同源（缓存 + 解析器兜底），否则同一选择器每次返回新对象 */
/* 桩对象是不是还挂在 doc.body 上（重画过板身 / 重渲染过宿主时旧对象会变孤儿） */
function stubInBody(n) {
  let cur = n;
  for (let i = 0; i < 200 && cur; i++) {
    if (cur === doc.body) return true;
    cur = cur.parentNode || null;
  }
  return false;
}
/* doc 级 querySelector：一律走 stubQS(doc.body, …)，与元素级同源，同一个选择器永远同一个对象 */
function docQS(sel) {
  return stubQS(doc.body, sel);
}
/* 元素级 / doc 级共用的规范化查找：先索引（id / class），再按当前树线性匹配 */
function stubQS(root, sel) {
  if (!root) return null;
  const s = String(sel || "").trim();
  if (!s) return null;
  const one = s.split(/\s+/).pop();
  if (stubEpoch === 0) stubBump();
  if (one.charAt(0) === "#") return stubIdMap()[one.slice(1)] || null;
  /* 每次按当前树线性找；同一个选择器仍返回同一个桩对象（树上就那一份） */
  for (const n of stubAll()) if (stubMatch(n, one)) return n;
  return null;
}
/* 选择器匹配（够测试里用到的几种：.cls / #id / tag / .cls[attr] / .cls[attr="v"] / .cls:not([attr])） */
function stubMatch(el, one) {
  if (!el || !one) return false;
  let rest = String(one);
  const cls = [];
  const clsRe = /\.([\w-]+)/g;
  let m;
  while ((m = clsRe.exec(rest))) cls.push(m[1]);
  rest = rest.replace(/\.[\w-]+/g, "");
  const notM = /\[([\w-]+)\]/.exec(rest);
  if (notM && one.indexOf(":not") >= 0) return cls.every((cc) => el.classList.contains(cc)) && el.getAttribute(notM[1]) == null;
  const attrM = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
  if (attrM) {
    if (!cls.every((cc) => el.classList.contains(cc))) return false;
    const v2 = el.getAttribute(attrM[1]);
    if (v2 == null) return false;
    return attrM[2] == null ? true : String(v2) === attrM[2];
  }
  if (rest.charAt(0) === "#") return el.id === rest.slice(1);
  /* 纯类选择器（.n-md-open-tip 这种）：剩下的 rest 是空串，别掉进标签比较 */
  if (cls.length) return cls.every((cc) => el.classList.contains(cc));
  if (!rest) return false;
  return el.tagName === rest.toUpperCase();
}function matchSimple(el, one) {
  if (!el || !one) return false;
  if (one.charAt(0) === "#") return el.id === one.slice(1);
  if (one.charAt(0) === ".") {
    const cls = one.slice(1).split(".").filter(Boolean);
    return cls.every((c) => el.classList.contains(c));
  }
  if (one.charAt(0) === "[") {
    /* 支持 [k] / [k="v"] 两种（宿主脚本里有 [data-mode="src"] 这类带值选择器） */
    const vm = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(one);
    if (!vm) return false;
    const v = el.getAttribute(vm[1]);
    if (v == null) return false;
    return vm[2] == null ? true : String(v) === vm[2];
  }
  return el.tagName === one.toUpperCase();
}
/* 父子链：挂上之后才能走后代选择器 */
function linkParents(el) {
  for (const c of el.children || []) {
    c._parentShell = el;
    linkParents(c);
  }
}
/* 节点板身桩：够 teBodyTa() 的 host.querySelector('textarea.n-text…') 命中板身那颗 textarea */
function mkNodeEl(id, ta) {
  const el = mkEl("div");
  el.id = id;
  el.appendChild(ta);
  el.querySelector = function (sel) {
    /* 祖先选择器（.n-x textarea）与 :not([readonly]) 这里的桩都不认：按「选择器含 n-text」收敛到这颗板身 textarea */
    if (String(sel).indexOf("n-text") >= 0 && ta.tagName === "TEXTAREA") return ta;
    /* 不在树上（提示已被摘掉 / 板身重画过）就不能再认旧对象 */
    if (stubMatch(ta, String(sel).trim()) && stubInBody(ta)) return ta;
    return null;
  };
  linkParents(el);
  return el;
}

const NODE = {
  id: "n_text_1",
  kind: "input_text",
  title: "文本节点 1",
  text: "# 标题\n\n正文第一段\n",
  review: {
    createdAt: 1,
    versions: [
      { text: "# 标题\n\n正文第一段\n", notes: [], ts: 1, src: "原始" },
    ],
    notesLog: [],
  },
};

const doc = {
  body: mkEl("body"),
  documentElement: mkEl("html"),
  createElement: (t) => mkEl(t),
  createDocumentFragment: () => {
    const f = mkEl("fragment");
    f._frag = true;
    return f;
  },
  createRange: () => ({
    createContextualFragment: (h) => {
      const w = mkEl("div");
      w.innerHTML = h;
      return w;
    },
  }),
  getElementById: (id) => {
    /* 按当前树现算：同一 id 永远拿到树上那个唯一对象（旧索引会留孤儿，改它等于没改） */
    return stubIdMap()[id] || null;
  },
  querySelector: (sel) => docQS(sel),
  addEventListener: () => {},
  execCommand: () => true,
};
doc.activeElement = null;
doc.body.appendChild = function (c) {
  doc.body.children.push(c);
  c._parentShell = doc.body;
  c.parentNode = doc.body;
  const reg = (n) => {
    if (n.id) doc.body._byId[n.id] = n;
    for (const k of n.children || []) reg(k);
  };
  reg(c);
  linkParents(doc.body);
  return c;
};

const windowStub = {
  innerWidth: 1600,
  innerHeight: 1000,
  addEventListener: () => {},
  getSelection: () => ({ isCollapsed: true, rangeCount: 0, removeAllRanges() {} }),
  marked: null,
  MTInlineImg: null,
  MTMathRender: null,
};
const savedCalls = [];
const sandbox = {
  console: console,
  document: doc,
  window: windowStub,
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  NodeFilter: { SHOW_TEXT: 4 },
  setTimeout: (f) => {
    if (typeof f === "function") return 0;
    return 0;
  },
  clearTimeout: () => {},
  /* 同步轮询：桩里不真起定时器（行为由测试直接调 teSyncTick 驱动），但句柄要能收 */
  setInterval: () => 1,
  clearInterval: () => {},
  Math: Math,
  Date: Date,
  Promise: Promise,
  S: { wf: { workspace: "E:\\dev\\tools\\pipeline-console" }, config: { providers: [] } },
  I18n: { t: (s) => s },
  nodeById: (id) => (id === NODE.id ? NODE : null),
  pushHistory: () => savedCalls.push("pushHistory"),
  scheduleSave: (im) => savedCalls.push("scheduleSave:" + (im ? "1" : "0")),
  renderCanvas: () => savedCalls.push("renderCanvas"),
  clearDownstream: (id) => savedCalls.push("clearDownstream:" + id),
  toast: (m, k) => savedCalls.push("toast:" + k + ":" + m),
  confirmDialog: () => Promise.resolve(true),
  mtDialogForm: () => Promise.resolve({ action: "cancel" }),
  promptDialog: () => Promise.resolve(null),
  wfWorkspace: () => "E:\\dev\\tools\\pipeline-console",
  ensureRunWorkspace: () => Promise.resolve(""),
  inputInherited: () => false,
  apiCallTextStream: () => Promise.resolve({ text: "修订后的正文" }),
  normalizeTextEffort: (v) => v || undefined,
  providerModelFilter: (p, m) => m || [],
  mdToRichHtml: (md) => "<p>" + String(md || "") + "</p>",
  richToMarkdown: (el) => (el && el._md ? el._md : "<序列化>"),
  buildRevisionPrompt: (text, log) => "PROMPT:" + text + "|NOTES:" + (log || []).length,
  stripFences: (t) => t,
  closeReviewDlg: () => savedCalls.push("closeReviewDlg"),
  textNodeEditorOpenFor: () => false,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(MOD, sandbox, { filename: "app-textedit.js" });

console.log("[1] 入口：可编辑的文本节点才给编辑器，节点头部 ✎ 已接线");
ok(
  typeof sandbox.openTextNodeEditor === "function",
  "app-textedit.js 顶层加载不抛错，出口 openTextNodeEditor 可用",
);
ok(
  sandbox.textNodeEditable({ kind: "input_text", text: "x" }) === true &&
    sandbox.textNodeEditable({ kind: "input_text", text: "x", ro: true }) === false &&
    sandbox.textNodeEditable({ kind: "proc_text" }) === false,
  "textNodeEditable：只读 / 拆分 / 非文本节点一律不给编辑器",
);
ok(
  CANVAS.indexOf("n-md-edit") >= 0 && CANVAS.indexOf("openTextNodeEditor(node)") >= 0,
  "节点头部 ✎（.n-md-edit）已接线 openTextNodeEditor",
);
ok(
  CANVAS.indexOf("me.textContent = \"✎\"") >= 0 &&
    CANVAS.indexOf("input_text\" && !node.ro && !inputInherited(node) && !node.batch") >= 0,
  "入口与 📄 文件参考同排，且只在可编辑文本节点上出现（板身 textarea 保留）",
);

console.log("\n[2] 窗口：近全屏 + 右下可拖调 + 显式关闭");
ok(
  MOD.indexOf('host.className = "review-dlg txmd-dlg"') >= 0 &&
    MOD.indexOf('class="review-box txmd-box"') >= 0,
  "宿主复用审阅窗壳（.review-dlg）并加自己的 .txmd-* 容器类",
);
ok(
  CSS.indexOf(".txmd-dlg .txmd-box {") >= 0 &&
    CSS.indexOf("width: 98vw;") >= 0 &&
    CSS.indexOf("height: 98vh;") >= 0 &&
    CSS.indexOf("min-width: 50vw;") >= 0,
  "css/textedit.css：近全屏 98vw × 98vh，最小宽 ≥ 50% 视口",
);
ok(
  MOD.indexOf('id="textEditResize"') >= 0 && MOD.indexOf("cursor: nwse-resize") < 0,
  "右下角有 resize 手柄（样式复用 review.css 的 .review-resize）",
);
const dragFn = fnBody(MOD, "function teEnsureHost()");
ok(
  dragFn.indexOf('window.innerWidth * 0.5') >= 0 && dragFn.indexOf("mousemove") >= 0,
  "拖调时最小宽钉在 50% 视口，且鼠标移动改的是盒子宽高",
);
ok(
  MOD.indexOf("function teToggleSize()") >= 0 &&
    MOD.indexOf("function teSyncSizeBtn()") >= 0 &&
    MOD.indexOf('host.querySelector("#textEditSizeBtn").onclick') >= 0,
  "另有放大 / 还原按钮并已接线",
);
ok(
  MOD.indexOf("host.addEventListener(\"keydown\", (ev) => {") >= 0 &&
    MOD.indexOf('ev.key === "Escape"') >= 0 &&
    MOD.indexOf('host.querySelector("#textEditCloseBtn").onclick') >= 0,
  "关闭只走显式路径（✕ / Esc），没有点外部即关的监听",
);

console.log("\n[3] 正文：所见即所得 + 源码档，转换与审阅同源");
const edFn = fnBody(MOD, "function teRenderEditor()");
ok(
  edFn.indexOf('ed.className = "rv-rich";') >= 0 &&
    edFn.indexOf('ed.contentEditable = "true";') >= 0 &&
    edFn.indexOf('ed.innerHTML = mdToRichHtml(text);') >= 0,
  "所见即所得档：contenteditable #textEditRich，正文由 mdToRichHtml 渲染",
);
ok(
  edFn.indexOf('ta.className = "rv-src";') >= 0 && edFn.indexOf('ta.id = "textEditSrc";') >= 0,
  "源码档：全文可改 textarea（#textEditSrc）",
);
ok(
  MOD.indexOf('Array.from(host.querySelectorAll(".rv-tab[data-mode]"))') >= 0 &&
    MOD.indexOf("function teSetView(want)") >= 0 &&
    MOD.indexOf("_te.src = src;") >= 0,
  "「编辑 / 源码」两档可切（tab 与 teSetView 同源）",
);
ok(
  MOD.indexOf("function teCommit()") >= 0 &&
    fnBody(MOD, "function teCommit()").indexOf("richToMarkdown(ed)") >= 0,
  "序列化回 Markdown 走 app-review.js 的 richToMarkdown（同一真源）",
);
ok(
  REVIEW.indexOf("function richToMarkdown(root) {") >= 0 &&
    REVIEW.indexOf("function mdToRichHtml(raw) {") >= 0 &&
    REVIEW.indexOf("function buildRevisionPrompt(text, log) {") >= 0,
  "app-review.js 仍是 mdToRichHtml / richToMarkdown / buildRevisionPrompt 的真源",
);

console.log("\n[4] 工具栏：与审阅同级的一套 Markdown 动作");
const tbFn = fnBody(MOD, "function teRenderToolbar()");
ok(tbFn.indexOf('b.className = "rv-tool";') >= 0, "方形 .rv-tool 按钮（复用 review.css）");
for (const act of [
  "h1", "h2", "h3", "p", "bold", "italic", "strike", "quote",
  "ul", "ol", "task", "hr", "link", "inlineCode", "code",
  "image", "table", "mathInline", "mathDisplay", "undo", "redo",
]) {
  ok(tbFn.indexOf('mk("' + act + '"') >= 0, "工具栏有动作 " + act);
}
ok(
  tbFn.indexOf('full.textContent = I18n.t("全文批注")') >= 0 &&
    tbFn.indexOf('local.textContent = I18n.t("局部批注")') >= 0,
  "工具栏另带「全文批注 / 局部批注」两个入口",
);
const actFn = fnBody(MOD, "function teToolbarOnRich(action, ed)");
ok(
  actFn.indexOf('exec("formatBlock"') >= 0 &&
    actFn.indexOf('exec("insertUnorderedList")') >= 0 &&
    actFn.indexOf('exec("bold")') >= 0,
  "结构 / 列表 / 行内动作走 execCommand，作用于当前富文本编辑区",
);
ok(
  MOD.indexOf("function teToolbarOnSource(action, ta)") >= 0 &&
    fnBody(MOD, "function teToolbarOnSource(action, ta)").indexOf("sourceHeading") < 0 &&
    fnBody(MOD, "function teToolbarOnSource(action, ta)").indexOf("const hashes =") >= 0,
  "源码档也有一套等价动作（直接改 Markdown 文本）",
);
ok(
  MOD.indexOf("function teInsertTable(ed, after)") >= 0 &&
    MOD.indexOf("function teInsertMath(ed, display, after)") >= 0 &&
    MOD.indexOf("latexToHtml") >= 0,
  "表格 / 公式走小对话框录入，公式用 math-render.js 渲染（LaTeX 原文留 data-rv-tex）",
);

console.log("\n[5] 批注与 AI 修订");
ok(
  MOD.indexOf("function teMaybeShowFloatNote(ed, ev)") >= 0 &&
    MOD.indexOf("function teShowFloatNote(x, y, snippet)") >= 0 &&
    MOD.indexOf('class="rv-note-in"') >= 0,
  "局部批注：拖选正文 → 浮空便笺（复用审阅的 .rv-note-* 样式）",
);
ok(
  MOD.indexOf("function teAddLocalNote(snippet, body)") >= 0 &&
    MOD.indexOf("function teAddFullNote(body)") >= 0 &&
    MOD.indexOf("function teDeleteNote(id)") >= 0,
  "全文 / 局部批注都能加，也能删",
);
ok(
  MOD.indexOf("function teTryReAnchor(nt, text)") >= 0 &&
    MOD.indexOf("nt.dead = true;") >= 0,
  "改文后局部批注自动就近重锚，找不到就标失效",
);
ok(
  MOD.indexOf("function teRenderRevisionButton()") >= 0 &&
    MOD.indexOf('I18n.t("让 AI 依据批注修订")') >= 0,
  "首个批注后顶部出现「让 AI 依据批注修订」（带条数）",
);
const revFn = fnBody(MOD, "async function teRunRevision()");
ok(
  revFn.indexOf("buildRevisionPrompt(v.text, teLog())") >= 0,
  "修订提示词 = 当前版全文 + 历史全部批注（与审阅同源）",
);
ok(
  revFn.indexOf("apiCallTextStream(spec, null, null)") >= 0 &&
    revFn.indexOf("vs.push({") >= 0,
  "修订用节点自身服务商+模型流式调用，结果作为新一版入链",
);
ok(
  MOD.indexOf("function teResolveProv(node)") >= 0 &&
    fnBody(MOD, "function teResolveProv(node)").indexOf('p.type === "text_openai"') >= 0,
  "服务商解析：节点 providerId 优先，回退任一可用文本服务商",
);

console.log("\n[6] 数据：共用 node.review，保存写 node.text");
ok(
  MOD.indexOf("node.review = {") >= 0 && MOD.indexOf("notesLog: []") >= 0,
  "打开时按 node.review 初始化版本链（与「✎ AI 审阅」同一份记录）",
);
const saveFn = fnBody(MOD, "function teSaveToNode(opts)");
ok(
  saveFn.indexOf("node.text = text;") >= 0,
  "保存写回 node.text",
);
ok(
  saveFn.indexOf("node.output") < 0,
  "不写 node.output（文本节点没有输出正文这个概念）",
);
ok(
  saveFn.indexOf("clearDownstream(node.id)") >= 0 &&
    saveFn.indexOf("renderCanvas()") >= 0 &&
    saveFn.indexOf("tePersist(!!o.immediate);") >= 0 &&
    MOD.indexOf("function tePersist(immediate)") >= 0 &&
    fnBody(MOD, "function tePersist(immediate)").indexOf("scheduleSave(!!immediate)") >= 0,
  "保存同时清下游中间结果 / 刷新画布 / 持久化",
);
/* ── 实时保存（本轮需求：markdown 编辑采用实时保存，不再要求主动保存） ── */
const flushFn = fnBody(MOD, "function teAutoFlush()");
ok(
  MOD.indexOf("const TE_SAVE_DEBOUNCE_MS = 600;") >= 0 &&
    MOD.indexOf("function teScheduleAutoSave()") >= 0 &&
    MOD.indexOf("teScheduleAutoSave();") >= 0,
  "① 停笔 600ms 自动落盘：有防抖常量与 teScheduleAutoSave（输入 / 工具栏 / 批注路径都会催一次）",
);
ok(
  fnBody(MOD, "function teScheduleAutoSave()").indexOf("_te.saveTimer = setTimeout(") >= 0 &&
    flushFn.indexOf("immediate: true") >= 0 &&
    flushFn.indexOf("clearDown: true") >= 0 &&
    flushFn.indexOf("silent: true") >= 0,
  "① 防抖到期调 teAutoFlush：立即落盘 + 清一次下游 + 不弹 toast（打字期间不清下游）",
);
ok(
  MOD.indexOf("function tePushToNode()") >= 0 &&
    fnBody(MOD, "function tePushToNode()").indexOf("if (changed) teScheduleAutoSave();") >= 0,
  "① 只有正文真的变了才排保存（700ms 轮询不会把「没打字」当成改动反复落盘）",
);
ok(
  MOD.indexOf("#textEditSaveBtn") < 0 && MOD.indexOf("function teSaveNow(opts)") >= 0,
  "① 顶部「保存」按钮已移除，Ctrl+S 仍是立即保存（teSaveNow）",
);
ok(
  MOD.indexOf('I18n.t("有未保存的改动")') < 0 &&
    MOD.indexOf('I18n.t("Ctrl+S 保存")') < 0 &&
    MOD.indexOf('I18n.t("已自动保存")') >= 0 &&
    MOD.indexOf('I18n.t("保存中…")') >= 0,
  "① 底栏状态行改成实时保存口径（已自动保存 / 保存中…），「未保存」字样不再出现",
);
const closeFn = fnBody(MOD, "async function teRequestClose()");
ok(
  closeFn.indexOf("confirmDialog(") < 0 && closeFn.indexOf('I18n.t("正文还有未保存的改动，要保存并关闭吗？")') < 0,
  "① 关窗不再夹问「未保存」确认框（实时保存下这个状态已不存在）",
);
ok(
  fnBody(MOD, "function teClose()").indexOf("teFlushPending()") >= 0 &&
    MOD.indexOf("function teFlushPending()") >= 0,
  "① 关窗前把待落盘的那一笔写完（不丢最后一次改动）",
);
ok(
  MOD.indexOf("function teSaveFailed(e)") >= 0 &&
    fnBody(MOD, "function teSaveFailed(e)").indexOf('teSetSave("err", msg)') >= 0 &&
    fnBody(MOD, "function teAutoFlush()").indexOf("teSaveFailed(e)") >= 0,
  "① 落盘失败：底栏转红写原因 + 一次 toast（teSaveFailed）",
);
ok(
  fnBody(MOD, "function teRenderFoot()").indexOf('_te.saveState') >= 0 &&
    MOD.indexOf("function teSetSave(s, err)") >= 0,
  "① 状态回显落在底栏状态行（字数 / 行数旁）",
);
ok(
  MOD.indexOf("function teRollbackTo(idx)") >= 0 &&
    fnBody(MOD, "function teRollbackTo(idx)").indexOf("vs[i].voided = true;") >= 0,
  "回滚 = 该版重设为当前可编辑，其后各版作废（仍可回看，不删记录）",
);
ok(
  MOD.indexOf("function textNodeEditorOpenFor(nodeId)") >= 0 &&
    REVIEW.indexOf("textNodeEditorOpenFor(node.id)") >= 0 &&
    MOD.indexOf("teReviewOpenFor(node.id)") >= 0,
  "同一节点上编辑器与 ✎ AI 审阅互斥（两个方向都有判据）",
);

console.log("\n[7] 插图：落盘到画布工作目录 assets/");
const imgFn = fnBody(MOD, "function teImgTarget()");
ok(
  imgFn.indexOf('kind: "fact"') >= 0 && imgFn.indexOf("assetsDir: teAssetsDir(ws)") >= 0,
  "插图落盘复用「复制进目录 + 相对引用」（main.js 的 fact:saveImage）",
);
ok(
  MOD.indexOf("function teAssetsDir(ws)") >= 0 &&
    fnBody(MOD, "function teAssetsDir(ws)").indexOf('"assets"') >= 0,
  "目标目录 = 工作目录/assets",
);
ok(
  imgFn.indexOf("ensureRunWorkspace(null)") >= 0 &&
    imgFn.indexOf('I18n.t("插图需要先设置画布工作目录：请在弹出的窗口里选一个文件夹")') >= 0,
  "没有工作目录时走画布工作目录闸门（弹现成的填写窗），不落绝对路径",
);
ok(
  MOD.indexOf("function teBindImageEditor(ed)") >= 0 &&
    fnBody(MOD, "function teBindImageEditor(ed)").indexOf("m.bindEditor(ed,") >= 0,
  "粘贴 / 拖入图片走共享模块 app-inline-img.js 的 bindEditor",
);

console.log("\n[8] 接线：脚本位 / 样式 / 词条");
const atReview = HTML.indexOf('src="app-review.js"');
const atMine = HTML.indexOf('src="app-textedit.js"');
ok(atMine > atReview && atReview >= 0, "index.html：app-textedit.js 排在 app-review.js 之后");
ok(
  STYLE.indexOf('@import url("./css/textedit.css");') >= 0 &&
    STYLE.indexOf('@import url("./css/review.css");') <
      STYLE.indexOf('@import url("./css/textedit.css");'),
  "style.css @import 了 textedit.css，且排在 review.css 之后（盒子尺寸以它为准）",
);
for (const k of [
  '"编辑正文（Markdown 编辑器）"',
  '"文本节点 · 正文实时保存（改动自动落盘）"',
  '"已自动保存"',
  '"保存中…"',
  '"Ctrl+S 立即保存"',
  '"已保存到节点正文"',
  '"该节点的 Markdown 编辑器正开着：请先关掉它，再开 AI 审阅"',
  '"插图需要先设置画布工作目录：请在弹出的窗口里选一个文件夹"',
  '"放大到全屏"',
  '"还原窗口大小"',
]) {
  ok(I18N.indexOf(k) >= 0, "英文词条：" + k.replace(/^"|"$/g, " ").trim().slice(0, 24));
}

/* ═══════════ 真跑一遍：打开 → 渲染 → 保存 ═══════════ */
console.log("\n[9] 真跑：打开编辑器 → 渲染宿主 → 保存写回节点");
/* 板身桩：模拟「文件节点-文本」那颗直接输入的 textarea（编辑器要与它完全同步） */
const bodyTa = mkEl("textarea");
bodyTa.className = "n-text";
doc.body.appendChild(mkNodeEl("node-" + NODE.id, bodyTa));
sandbox.openTextNodeEditor(NODE);
const host = doc.getElementById("textEditDlg");
/* 真实应用里 openTextNodeEditor 末尾会把焦点给宿主窗壳：同步轮询不该因此罢工 */
doc.activeElement = host;
ok(!!host, "打开后 #textEditDlg 已建出来");
ok(host && host.classList.contains("on"), "宿主进入显示态（.on）");
ok(
  NODE.review.versions.length === 1 && NODE.review.versions[0].text === NODE.text,
  "打开时用节点正文做了原始稿 V1",
);
ok(
  !!bodyTa && bodyTa.readOnly === true && bodyTa.classList.contains("n-md-synced"),
  "编辑器开着时板身 textarea 只读并标记为同步态",
);
ok(
  !!doc.querySelector(".n-md-open-tip"),
  "板身给出「正文在编辑器里改、这里只读并实时同步」的提示",
);
ok(
  String(bodyTa.value) === String(NODE.text),
  "板身 textarea 与节点正文一致（开窗即同步）",
);
const tb = doc.getElementById("textEditToolbar");
ok(!!tb && tb.children.length >= 20, "工具栏渲染出 " + (tb ? tb.children.length : 0) + " 个按钮");
const rich = doc.getElementById("textEditRich");
ok(!!rich && rich.contentEditable === "true", "富文本编辑区已挂上（contenteditable）");
const revise = doc.getElementById("textEditReviseBtn");
ok(!!revise && revise.hidden === true, "没有批注时「让 AI 依据批注修订」隐藏");
/* 加一条全文批注 → 修订按钮应出现 */
sandbox.teAddFullNote("把第一段写细一点");
const cur = NODE.review.versions[NODE.review.versions.length - 1];
ok(cur.notes.length === 1, "全文批注已记进当前版 notes");
const revise2 = doc.getElementById("textEditReviseBtn");
ok(!!revise2 && revise2.hidden === false, "出现批注后修订按钮显示出来");
ok(
  String(sandbox.teRenderRevisionButton ? "" : "") === "" &&
    doc.getElementById("textEditReviseTxt").textContent.indexOf("1") >= 0,
  "修订按钮带批注条数",
);
/* 模拟用户在富文本里改了正文，再保存（保存内部先 commit 序列化，不能存成上一版） */
rich._md = "# 标题\n\n改过的正文\n";
savedCalls.length = 0;
sandbox.teSaveNow();
const savedText = NODE.text;
savedCalls.length = 0;
sandbox.teSaveNow();
ok(savedText === "# 标题\n\n改过的正文\n", "保存把当前版正文写回 node.text");
ok(
  fnBody(MOD, "function teSaveToNode(opts)").indexOf("if (!o.skipCommit) teCommit();") >= 0,
  "保存前先 commit（刚打的字不会丢，写下去的不是上一版）",
);
ok(
  String(bodyTa.value) === String(NODE.text),
  "编辑器里存下去，板身 textarea 同步成同一份正文",
);
ok(
  savedCalls.indexOf("clearDownstream:" + NODE.id) >= 0 &&
    savedCalls.indexOf("renderCanvas") >= 0 &&
    savedCalls.some((x) => x.indexOf("scheduleSave") === 0),
  "保存顺带清下游 / 刷新画布 / 持久化",
);
ok(
  NODE.review.versions[NODE.review.versions.length - 1].text === NODE.text,
  "版本链当前版与 node.text 一致（两处不会漂）",
);

/* 关窗：板身 textarea 放回可编辑，提示收掉 */
sandbox.teClose();
ok(
  bodyTa.readOnly !== true && !bodyTa.classList.contains("n-md-synced"),
  "关窗后板身 textarea 恢复可编辑（同步态标记一并撤掉）",
);
ok(!doc.querySelector(".n-md-open-tip"), "关窗后那行提示收掉");

/* ── [9b] 板身直接输入 ⇄ 编辑器正文：两个方向都必须同步 ── */
console.log("\n[9b] 双向同步：板身直接输入 ⇄ Markdown 编辑器");
const bodyText = "# 板身输入\n\n这段是在节点板身 textarea 里直接敲的。\n";
NODE.text = bodyText;
sandbox.openTextNodeEditor(NODE);
ok(
  NODE.review.versions[NODE.review.versions.length - 1].text === bodyText,
  "板身直接输入的内容在开窗时拉进当前版（不被旧版本链压住）",
);
ok(
  String(bodyTa.value) === bodyText && bodyTa.readOnly === true,
  "开窗后板身 textarea 显示同一份正文且只读",
);
/* 编辑器里改：commit 之后随即写回 node.text 与板身 textarea */
const rich2 = doc.getElementById("textEditRich");
const editorText = "# 编辑器输入\n\n这段是在 Markdown 编辑器里敲的。\n";
rich2._md = editorText;
sandbox.teCommit();
ok(NODE.text === editorText, "编辑器里的正文写回 node.text");
ok(String(bodyTa.value) === editorText, "板身 textarea 同步成编辑器里的正文");
/* 别的路径改了 node.text（板身重画 / 导入文件 / 上游写入）：轮询把它拉回编辑器 */
const external = "# 外部写入\n\n这段是从别的路径写进节点正文的。\n";
NODE.text = external;
sandbox.teSyncTick();
ok(
  NODE.review.versions[NODE.review.versions.length - 1].text === external,
  "轮询发现 node.text 变了 → 当前版跟着变（编辑器与节点不漂）",
);
ok(String(bodyTa.value) === external, "板身 textarea 与编辑器显示的仍是同一份正文");
/* 关窗收口：放回可编辑，且不再有定时器句柄 */
sandbox.teClose();
ok(bodyTa.readOnly !== true, "关窗后板身 textarea 恢复可编辑");
ok(sandbox.teSyncTimer === 0 || sandbox.teSyncTimer === undefined || !sandbox.teSyncTimer, "关窗停掉同步轮询");
/* 源码档输入也要同步（切到源码档改全文的那条路径） */
NODE.text = "# 源码档\n\n源码里改的。\n";
sandbox.openTextNodeEditor(NODE);
sandbox.teSetView(true);
const srcTa = doc.getElementById("textEditSrc");
ok(!!srcTa, "源码档切出来后 #textEditSrc 挂上");
const srcText = "# 源码档改过\n\n源码档里改的。\n";
if (srcTa) {
  srcTa.value = srcText;
  srcTa.oninput();
}
ok(NODE.text === srcText, "源码档里的改动也写回 node.text（两个编辑面同源）");
ok(String(bodyTa.value) === srcText, "源码档改动同步到板身 textarea");
sandbox.teClose();
console.log(
  (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
    checks +
    " 项" +
    (fails ? "，失败 " + fails + " 项" : "通过"),
);
process.exit(fails ? 1 : 0);
