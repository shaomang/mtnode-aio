"use strict";
/* test/smoke-ask-keep-input.js — 「弹出多个询问窗时，前一个窗的内容被清空重置」回归
 * ============================================================================
 * 运行：node test/smoke-ask-keep-input.js
 *
 * 根因（三处同源）：全应用三套弹窗宿主都是「单例 + 开新窗前清空内容」——
 *   A #ixPanel（「🐋 模型等待你的回应」）：renderIxPanel() 每次重绘 box.innerHTML=""
 *     整窗重建 → 第二条卡一到，前一张卡里已填的「其他（自定义回答）」与已勾选项全没；
 *   B #mtDialog（promptDialog / confirmDialog / mtDialogForm 共用）：第二个窗起来
 *     body.innerHTML="" 冲掉前一只窗，且旧 Promise 因 _mtDialogSeq 变化**永不 resolve**
 *     （等它的调用方永久挂住）；
 *   C #overlay（canvas 修改 / 危险操作确认框 confirmAssistAction）：新窗把用户正开着的
 *     节点设置窗（或反过来）当场清空重建。
 *
 * 已与用户确认的修法：
 *   A 重绘前把卡面抄进内存草稿（键 = 卡 id + 题 id），重绘后回填输入与勾选，并保住光标；
 *     草稿活到该卡被提交 / 被撤为止，不落盘、不跨重启、不加提示词条。
 *   B 仍是单例阻塞弹窗：新窗起来时把前一只当场以「已取消」（false / null / 取消动作）
 *     结算并关掉 —— 与 Esc / 取消同一约定，调用方不必改代码，也不再永久挂住。
 *   C **（后续需求改写）** 本轮「移除 footer 最小化与所有的最小化，仅保留关闭」之后，
 *     开新窗 = 原地换窗：旧窗内容当场作废，不再有「收进状态栏页签」这一档，
 *     也不再需要 ovMinDropWindow 去摘停放框。本文件 [4] 已翻面成「停放链已删干净」的断言。
 *
 * 覆盖：
 *   [1] A 的静态接线（存取顺序 · 清理点 · 回填函数）
 *   [2] A 的真跑：假 DOM + vm 跑 app-db.js 询问窗整段，两卡在手时前一张卡内容不丢
 *   [3] B 的静态接线 + vm 真跑：单例换窗 → 旧窗当场结算、按键监听不被新窗误摘
 *   [4] C 的静态接线 + vm 真跑：openOverlay 原地换窗（既无停放、也无最小化页签）
 * 只跑本机 Node + 假 DOM：不拉浏览器、不碰 Electron、不改任何文件。
 * ============================================================================
 */
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
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 52)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 源码不含 " + JSON.stringify(String(needle).slice(0, 52)));
}
/** 按名字抠一个平铺 function 声明（花括号配平） */
function fnSrc(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  return "";
}

/* 需要等微任务的断言排到这里，最后统一跑（Promise 结算在微任务里发生） */
const asyncChecks = [];

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const DB = read("renderer/app-db.js");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");

/* ════════════════════════════════════════════════════════════════════════════
   [1] A：询问窗（#ixPanel）草稿保活 —— 静态接线
   ════════════════════════════════════════════════════════════════════════════ */
console.log("\n[1] #ixPanel 草稿保活：接线与顺序");
has(DB, "let ixDraft = Object.create(null);", "新增模块级草稿表 ixDraft（只活在内存里）");
has(DB, "function ixDraftSaveFromDom() {", "重绘前抄当前卡面 ixDraftSaveFromDom");
has(DB, "function ixRestoreQuestionDraft(card, q, custom, optInputs, onCustomInput) {", "重绘后按卡 + 题回填 ixRestoreQuestionDraft");
has(DB, "function ixFocusSaveFromDom() {", "记住正在打字的那个框（光标位置）");
has(DB, "function ixFocusRestoreToDom() {", "重绘后把光标放回原处");
has(DB, 'const qid = String(inp.dataset && inp.dataset.qid ? inp.dataset.qid : "");', "草稿键带题 id（q1 / confirm 这类重复题 id 不串题）");
has(DB, "const d = ixDraftCardOf(card.id.slice(7));", "草稿按卡 id 归位（ixCard_ 前缀切掉）");
has(DB, "ixDraftDropCard(id);", "ixDrop（答完 / 被撤）清掉该卡草稿");
has(DB, "if (x.runKey === runKey && x.data && x.data.id) ixDraftDropCard(x.data.id);", "ixDropRun 清掉该轮各家卡的草稿");
has(DB, "ixDraft = Object.create(null);", "ixReset（整窗作废）清空全部草稿");
has(DB, "if (items.indexOf(x) < 0 && x.data && x.data.id) ixDraftDropCard(x.data.id);", "孤儿卡清理时草稿一起走（不留死草稿）");
{
  const rp = fnSrc(DB, "renderIxPanel");
  const iSave = rp.indexOf("ixDraftSaveFromDom();");
  const iFocusSave = rp.indexOf("ixFocusSaveFromDom();");
  /* 整窗清空那一步（注释里也引用了同一行代码，这里按「赋值语句」的写法认：
     'box.innerHTML = "";' 才算代码，注释里那句是全角括号结尾，不会误命中） */
  const iWipe = rp.indexOf('box.innerHTML = "";');
  const iRestore = rp.lastIndexOf("ixFocusRestoreToDom();");
  ok(iSave > 0 && iWipe > iSave, "renderIxPanel：抄草稿排在整窗清空之前（顺序即正确性）");
  ok(iFocusSave > 0 && iWipe > iFocusSave, "renderIxPanel：抄光标也排在清空之前");
  ok(iRestore > iWipe, "renderIxPanel：清空并重建之后才放回光标");
  /* 题面渲染器抽成一份之后（提问卡与求助卡共用，见 ixRenderQuestions），
     「每题构字段 + 挂上回填」整段搬进了那个函数：回填仍必须排在该题字段全部挂好之后。 */
  const rq = fnSrc(DB, "ixRenderQuestions");
  const iRestoreCall = rq.indexOf("ixRestoreQuestionDraft(card, q, custom, optInputs, onCustomInput);");
  const iAppendCustom = rq.indexOf("card.appendChild(custom);");
  ok(iRestoreCall > 0, "每题的正文框接上回填（ixRenderQuestions 里，字段构好之后）");
  ok(iAppendCustom > 0 && iRestoreCall > iAppendCustom, "回填排在该题字段全部挂好之后（勾选与手填同帧对上）");
  ok(rp.indexOf("ixRenderQuestions(card, it,") > 0, "renderIxPanel 两族卡片都调同一份题面渲染器");
}
{
  const band = fnSrc(DB, "ixRestoreQuestionDraft");
  ok(band.indexOf("inp.checked = picked.indexOf(String(inp.value)) >= 0;") > 0, "回填按 value 对号恢复勾选");
  ok(band.indexOf("if (typeof onCustomInput === \"function\") onCustomInput();") > 0, "回填手填时走同一条「选项 / 手填互斥」规则");
  const iChecked = band.indexOf("inp.checked = picked.indexOf");
  const iText = band.indexOf("custom.value = text;");
  ok(iChecked > 0 && iText > iChecked, "先恢复勾选、再按互斥还原手填（与用户手填同顺序，避免提交时自相矛盾）");
}
no(DB, 'qd.text = String(inp.value || "");\n    if (ixDraftAlive(qd)) delete', "空草稿不留残条（ixDraftAlive 判活）");

/* ════════════════════════════════════════════════════════════════════════════
   假 DOM：足够跑 app-db.js 的询问窗渲染 / 草稿存取（真源码，不重写逻辑）
   ════════════════════════════════════════════════════════════════════════════ */
function mkDom() {
  let seq = 0;
  const all = [];
  function mkEl(tag) {
    const el = {
      __seq: ++seq,
      tag,
      id: "",
      className: "",
      textContent: "",
      _html: "",
      type: "",
      title: "",
      placeholder: "",
      value: "",
      checked: false,
      hidden: false,
      dataset: {},
      style: {},
      children: [],
      parentNode: null,
      onclick: null,
      _lis: {},
      classList: {
        add(c) {
          const l = String(el.className || "").split(/\s+/).filter(Boolean);
          if (l.indexOf(c) < 0) l.push(c);
          el.className = l.join(" ");
        },
        remove(c) {
          el.className = String(el.className || "")
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(" ");
        },
        contains(c) {
          return String(el.className || "").split(/\s+/).indexOf(c) >= 0;
        },
        toggle(c, on) {
          if (on) el.classList.add(c);
          else el.classList.remove(c);
        },
      },
      addEventListener(t, f) {
        (el._lis[t] = el._lis[t] || []).push(f);
      },
      removeEventListener(t, f) {
        const l = el._lis[t] || [];
        const i = l.indexOf(f);
        if (i >= 0) l.splice(i, 1);
      },
      dispatch(t, ev) {
        for (const f of (el._lis[t] || []).slice()) f(ev || { type: t });
      },
      appendChild(c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = el;
        el.children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        if (!ref) return el.appendChild(c);
        const i = el.children.indexOf(ref);
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = el;
        if (i < 0) el.children.push(c);
        else el.children.splice(i, 0, c);
        return c;
      },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i >= 0) el.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      },
      remove() {
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      contains() {
        return false;
      },
      closest(sel) {
        let n = el;
        while (n) {
          if (matchSel(n, sel)) return n;
          n = n.parentNode;
        }
        return null;
      },
      focus() {
        DOC.activeElement = el;
      },
      setSelectionRange(a, b) {
        el.selectionStart = a;
        el.selectionEnd = b;
      },
      setAttribute(k, v) {
        el[k] = String(v);
      },
      removeAttribute(k) {
        delete el[k];
      },
      getAttribute(k) {
        return el[k] === undefined ? null : el[k];
      },
      querySelector(sel) {
        return qsa(el, sel)[0] || null;
      },
      querySelectorAll(sel) {
        return qsa(el, sel);
      },
    };
    all.push(el);
    /* checked 就是普通可写属性（真 DOM 里也一样） */
    el.checked = false;
    /* innerHTML：真 DOM 里写 "" 就是清空子节点，写 HTML 串就解析成子节点。
       只实现到「本文件用得到」的程度：标签 / 属性 / 文本 / 自闭合，够解析
       app.js 的 OV_SHELL_HTML 那种静态窗壳。 */
    Object.defineProperty(el, "innerHTML", {
      get() {
        return el._html;
      },
      set(v) {
        el._html = String(v == null ? "" : v);
        for (const c of el.children.slice()) c.parentNode = null;
        el.children.length = 0;
        if (!el._html) return;
        for (const node of parseHtml(el._html)) el.appendChild(node);
      },
    });
    return el;
  }
  /* 极简 HTML → 元素树（div / b / button / svg / path + class / id / title / aria-*） */
  function parseHtml(html) {
    const out = [];
    const stack = [{ children: out, appendChild(c) { out.push(c); } }];
    const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[1];
      if (tag && m[0].charAt(1) !== "/") {
        const node = mkEl(tag);
        const attrs = m[2] || "";
        const ar = /([\w:-]+)(?:="([^"]*)")?/g;
        let a;
        while ((a = ar.exec(attrs))) {
          const k = a[1];
          const val = a[2] == null ? "" : a[2];
          if (k === "class") node.className = val;
          else if (k === "id") node.id = val;
          else if (k === "title") node.title = val;
          else node[k] = val;
        }
        const top = stack[stack.length - 1];
        top.appendChild(node);
        if (!m[3]) stack.push(node);
      } else if (tag && m[0].charAt(1) === "/") {
        if (stack.length > 1) stack.pop();
      }
      /* 纯文本节点不入树：本套断言只认元素（选择器也不匹配文本） */
    }
    return out;
  }
  function walk(root, out) {
    out = out || [];
    for (const c of root.children || []) {
      out.push(c);
      walk(c, out);
    }
    return out;
  }
  /* 选择器只支持本文件用到的写法：tag / .cls / #id / tag.cls / 「A B」后代 / 「A > B」子元素。
     注意别对不含空格的选择器递归自己（那会无限递归）—— 「A > B」与「A B」都在 qsa 里先拆开。 */
  function matchSel(el, sel) {
    sel = String(sel).trim();
    if (!sel) return false;
    const dot = sel.indexOf(".");
    if (dot >= 0) {
      const tag = sel.slice(0, dot);
      const cls = sel.slice(dot + 1);
      return (!tag || el.tag === tag) && el.classList.contains(cls);
    }
    if (sel.charAt(0) === "#") return el.id === sel.slice(1);
    return el.tag === sel;
  }
  function qsa(root, sel) {
    sel = String(sel).trim();
    /* :scope 前缀（真 DOM 里表示「以 root 为参照」，这里的 walk 本来就是从 root 往下走） */
    sel = sel.replace(/^:scope\s*>?\s*/, "");
    if (!sel) return [];
    /* 「A > B」= 直接子元素；「A B」= 后代（只用到这两种，本文件里够用） */
    const child = sel.indexOf(">");
    if (child > 0) {
      const parentSel = sel.slice(0, child).trim();
      const leaf = sel.slice(child + 1).trim();
      const out = [];
      for (const el of walk(root)) {
        if (matchSel(el, leaf) && el.parentNode && matchSel(el.parentNode, parentSel)) out.push(el);
      }
      return out;
    }
    const parentSel = sel.indexOf(" ") > 0 ? sel.split(/\s+/)[0] : "";
    const leaf = sel.indexOf(" ") > 0 ? sel.split(/\s+/).pop() : sel;
    const out = [];
    for (const el of walk(root)) {
      if (!matchSel(el, leaf)) continue;
      if (parentSel && !(el.parentNode && matchSel(el.parentNode, parentSel))) continue;
      out.push(el);
    }
    return out;
  }
  const body = mkEl("body");
  const DOC = {
    body,
    activeElement: null,
    createElement: (t) => mkEl(t),
    createDocumentFragment: () => mkEl("fragment"),
    getElementById(id) {
      for (const el of walk(body)) if (el.id === id) return el;
      return null;
    },
    querySelector(sel) {
      return qsa(body, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return qsa(body, sel);
    },
  };
  return { DOC, body, mkEl, walk, matchSel };
}

const DB_SLICE = (() => {
  /* 线上顺序：ixReset → ixDrop / ixDropRun → 草稿与焦点助手 → 位置函数 → renderIxPanel；
     而 renderIxPanel 用到的 ixLaterButton / ixAbortButton 两个按钮函数排在它前面
     （ixLaterButton 之前）。所以三段拼接：
       ① ixReset 段 → renderIxPanel 之前（含草稿助手、清理、位置，且在按钮函数之后）
       ② 按钮函数段（ixLaterButton → 草稿段之前）
       ③ renderIxPanel → 主题段之前（渲染本体，含回填接线）
     三段互不重叠，拼起来就是线上那份逻辑，没有重复声明。 */
  const at = (m) => DB.indexOf(m);
  const aReset = at("/* 「稍后（终止本轮）」出口");
  const aBtn = at("function ixLaterButton(it) {");
  const aDraft = at("/* ── 询问窗草稿");
  const aPanel = at("function renderIxPanel() {");
  const aTheme = at("/* ── 主题(dsh = 默认");
  if (aReset < 0 || aBtn < 0 || aDraft < 0 || aPanel < 0 || aTheme < 0) return "";
  if (!(aReset < aBtn && aBtn < aDraft && aDraft < aPanel && aPanel < aTheme)) return "";
  return DB.slice(aReset, aPanel) + "\n" + DB.slice(aBtn, aDraft) + "\n" + DB.slice(aPanel, aTheme);
})();
ok(!!DB_SLICE, "抠到 app-db.js 询问窗整段（ixReset → 主题段之前）");
ok(
  DB_SLICE.indexOf("let ixDraft = Object.create(null);") === DB_SLICE.lastIndexOf("let ixDraft = Object.create(null);"),
  "拼接后的片段没有重复声明（只声明一次 ixDraft）",
);
ok(
  DB_SLICE.indexOf("function renderIxPanel() {") > 0 && DB_SLICE.indexOf("function ixLaterButton(it) {") > 0,
  "拼接后的片段同时含 renderIxPanel 与它的按钮函数",
);

function mkPanelCtx(dom) {
  const c = {
    console: { log() {}, error() {} },
    document: dom.DOC,
    S: { activeIx: { items: [] } },
    I18n: { t: (k) => String(k) },
    $: (sel) => (String(sel).charAt(0) === "#" ? dom.DOC.getElementById(String(sel).slice(1)) : dom.DOC.querySelector(sel)),
    window: { innerWidth: 1600, innerHeight: 900, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    ixFreshCard: false,
    ixFreshPulse: false,
    ixPruneAllInteraction: () => {},
    ixMakeDraggable: () => {},
    ixRestorePos: () => {},
    ixRevealNewCard: () => {},
    renderMarkdown: (s) => "<p>" + String(s) + "</p>",
    toast: () => {},
    playIxSound: () => {},
    dshRunUserMark: () => {},
    esc: (s) => String(s),
  };
  const ctx = vm.createContext(c);
  vm.runInContext(DB_SLICE, ctx, { filename: "app-db.js#ixPanel" });
  return ctx;
}
const QUESTION = (id, qid) => ({
  kind: "question",
  runKey: "",
  data: {
    id,
    questions: [
      {
        id: qid,
        question: "选一个方向？",
        options: [{ label: "方案 A" }, { label: "方案 B" }],
      },
    ],
  },
});
const bodyCards = (dom) => dom.walk(dom.body).filter((e) => e.classList.contains("ix-card"));
const byClass = (dom, cls) => dom.walk(dom.body).filter((e) => e.classList.contains(cls));

/* ════════════════════════════════════════════════════════════════════════════
   [2] A 真跑：两卡在手 → 前一张卡填的内容不丢（本次 bug 的正身）
   ════════════════════════════════════════════════════════════════════════════ */
console.log("\n[2] #ixPanel 真跑（假 DOM · 第二张卡到来时前一张卡的内容还在）");
{
  const dom = mkDom();
  const ctx = mkPanelCtx(dom);
  ctx.S.activeIx.items.push(QUESTION("card1", "q1"));
  vm.runInContext("renderIxPanel();", ctx);
  let cards = bodyCards(dom);
  ok(cards.length === 1 && cards[0].id === "ixCard_card1", "第一张卡渲染出来");

  /* 头部常驻（本次开发需求「上方拖动条不应跟着下方下拉而下拉」）：
     拖动条与内容滚动容器都是窗的直接子节点，卡片挂在滚动容器里 ——
     所以往下滚内容时被滚走的是卡片，头部原地不动。 */
  const panel = dom.body.children.filter((e) => e.id === "ixPanel")[0];
  const heads = panel ? panel.children.filter((e) => e.classList.contains("ix-head")) : [];
  const bodies = panel ? panel.children.filter((e) => e.classList.contains("ix-body")) : [];
  ok(heads.length === 1 && bodies.length === 1, "窗里恰好一条拖动条 + 一个内容滚动容器");
  ok(
    heads[0].parentNode === panel && bodies[0].parentNode === panel,
    "拖动条挂在窗上、不在滚动容器里（内容滚动时它不会被一起滚走）",
  );
  ok(cards[0].parentNode === bodies[0], "卡片进的是 .ix-body（滚动只发生在它身上）");
  /* 滚轮停在拖动条那一条上也要把正文滚起来（从前整只窗自己滚，滚轮在哪儿都灵） */
  let wheelPrevented = false;
  bodies[0].scrollTop = 0;
  heads[0].dispatch("wheel", {
    type: "wheel",
    deltaY: 40,
    preventDefault() {
      wheelPrevented = true;
    },
  });
  ok(
    bodies[0].scrollTop === 40 && wheelPrevented,
    "滚轮落在拖动条上 → 转发给 .ix-body（滚轮位置不再有死角）",
  );
  bodies[0].scrollTop = 0;

  /* 用户在第一张卡上：勾了「方案 B」、又在「其他（自定义回答）」里写了字（互斥规则会撤掉勾选） */
  const custom1 = byClass(dom, "ix-custom")[0];
  const opts1 = byClass(dom, "ix-opt").map((l) => l.children.filter((x) => x.tag === "input")[0]);
  opts1[1].checked = true;
  custom1.value = "我自己的想法：先做 A 再做 B";
  custom1.focus();
  custom1.setSelectionRange(3, 3);
  custom1.dispatch("input");
  ok(opts1[0].checked === false && opts1[1].checked === false, "手填即撤掉已勾选项（互斥规则，修复前的老行为不变）");

  /* 第二张卡到达：renderIxPanel 会整窗重建（这正是原来清空前一张卡的那一步） */
  ctx.S.activeIx.items.push(QUESTION("card2", "q1"));
  vm.runInContext("renderIxPanel();", ctx);
  cards = bodyCards(dom);
  ok(cards.length === 2, "两张卡同时在窗里（并行两轮各弹一张）");
  const customEls = byClass(dom, "ix-custom");
  ok(customEls.length === 2, "两张卡各有自己的「其他（自定义回答）」");
  const restored = customEls.filter((e) => e.closest(".ix-card").id === "ixCard_card1")[0];
  const fresh = customEls.filter((e) => e.closest(".ix-card").id === "ixCard_card2")[0];
  ok(
    restored && restored.value === "我自己的想法：先做 A 再做 B",
    "前一张卡里已经打好的字还在（本次 bug 的正身：不再被清空重置）",
  );
  ok(fresh && fresh.value === "", "后到的卡不被前一张卡的内容污染");
  ok(dom.DOC.activeElement === restored && restored.selectionStart === 3, "正在打字的光标也放回原处（值 + 位置）");
  ok(
    byClass(dom, "ix-opt").filter((l) => l.closest(".ix-card").id === "ixCard_card1").every(
      (l) => l.children.filter((x) => x.tag === "input")[0].checked === false,
    ),
    "草稿里只有手填 → 回填后仍无勾选（互斥语义与面板显示一致）",
  );

  /* 纯勾选（没手填）也要留住：先按真实界面口径把两者的互斥做出来 ——
     用户改点选项时 change 会清掉手填文字（renderIxPanel 里那条既有规则），
     这一格之后填的就是「纯勾选」这一种意图。 */
  const opts2 = byClass(dom, "ix-opt").filter((l) => l.closest(".ix-card").id === "ixCard_card1");
  opts2[0].children.filter((x) => x.tag === "input")[0].checked = true;
  byClass(dom, "ix-custom").filter((e) => e.closest(".ix-card").id === "ixCard_card1")[0].value = "";
  ctx.S.activeIx.items.push(QUESTION("card3", "q1"));
  vm.runInContext("renderIxPanel();", ctx);
  const card1Opts = byClass(dom, "ix-opt").filter((l) => l.closest(".ix-card").id === "ixCard_card1");
  ok(card1Opts[0].children.filter((x) => x.tag === "input")[0].checked === true, "只勾选项的答案同样留住（第二张卡到来后仍在）");
  const card2Custom = byClass(dom, "ix-custom").filter((e) => e.closest(".ix-card").id === "ixCard_card2")[0];
  ok(card2Custom.value === "", "选完选项不再残留手填（回填与互斥同一套规则）");

  /* 提交 / 撤卡 → 草稿作废，不留到下一轮同 id 的卡 */
  /* 先把正在打字的光标从询问窗里挪开：否则 ixReset / 重建都会先把卡面抄进草稿，
     这不是 bug，是「抄在清空之前」的正确顺序；本段只想验「撤卡把草稿一起作废」 */
  dom.DOC.activeElement = null;
  vm.runInContext('ixDrop("card1");', ctx);
  ok(bodyCards(dom).length === 2, "ixDrop 撤掉答完的卡");
  ctx.S.activeIx.items.push(QUESTION("card1", "q1"));
  vm.runInContext("renderIxPanel();", ctx);
  const again = byClass(dom, "ix-custom").filter((e) => e.closest(".ix-card").id === "ixCard_card1")[0];
  ok(again && again.value === "", "同 id 的卡再来时草稿已随撤卡作废（不会把旧答案捞回来）");
  vm.runInContext("ixReset();", ctx);
  ok(bodyCards(dom).length === 0, "ixReset 收干净");
}

/* ════════════════════════════════════════════════════════════════════════════
   [3] B：#mtDialog 单例换窗 → 旧窗当场以「已取消」结算（不再永久挂住）
   ════════════════════════════════════════════════════════════════════════════ */
console.log("\n[3] #mtDialog 单例换窗：旧窗结算 · 监听归属");
has(APP, "let _mtDlgActive = null;", "新增当前窗登记 _mtDlgActive");
has(APP, "function mtDlgSupersede() {", "新增顶窗出口 mtDlgSupersede");
has(APP, "prev.finish(); /* 无参数 = 走各自的「取消」语义", "顶掉 = 走「取消」语义结算（调用方不必改代码）");
has(APP, "if (typeof prev.close === \"function\") prev.close();", "顶掉时顺手收掉弹窗宿主");
{
  const cd = fnSrc(APP, "confirmDialog");
  const pd = fnSrc(APP, "promptDialog");
  const mf = fnSrc(APP, "mtDialogForm");
  ok(cd.indexOf("mtDlgSupersede();") > 0 && cd.indexOf("mtDlgSupersede();") < cd.indexOf("const seq = ++_mtDialogSeq;"), "confirmDialog：先结算旧窗、再拿新序号");
  ok(pd.indexOf("mtDlgSupersede();") > 0 && pd.indexOf("mtDlgSupersede();") < pd.indexOf("const seq = ++_mtDialogSeq;"), "promptDialog：同上");
  ok(mf.indexOf("mtDlgSupersede();") > 0 && mf.indexOf("mtDlgSupersede();") < mf.indexOf("const seq = ++_mtDialogSeq;"), "mtDialogForm：同上");
  ok(cd.indexOf("resolve(false);") > 0, "confirmDialog 的顶窗出口结算成 false（= 取消）");
  ok(pd.indexOf("resolve(null);") > 0, "promptDialog 的顶窗出口结算成 null（= 取消）");
  ok(cd.indexOf("host.removeEventListener(\"keydown\", onKey);") > 0, "顶窗出口只摘自己的按键监听（不替新窗收尾）");
  const reg = mf.indexOf("_mtDlgActive = { finish: mySupersede, close: closeMtDialog };");
  const lis = mf.indexOf('host.addEventListener("keydown", onKey);');
  ok(reg > 0 && lis > 0 && reg > lis, "登记排在监听之后（顶窗那一步的 removeEventListener 不会把新窗的监听摘掉）");
  ok(mf.indexOf("if (_mtDlgActive && _mtDlgActive.finish === mySupersede) _mtDlgActive = null;") > 0, "只有「还是我」才清登记（归属判定，同 ixConfirmId / overlayIsMine 口径）");
}
{
  /* 真跑：把 app.js 的 #mtDialog 三个函数抠出来，配假 DOM，看旧窗的 Promise 是否当场结清 */
  const dom = mkDom();
  const host = dom.mkEl("div");
  host.id = "mtDialog";
  host.className = "mt-dialog";
  const box = dom.mkEl("div");
  box.className = "mt-dialog-box";
  const head = dom.mkEl("div");
  const title = dom.mkEl("b");
  title.id = "mtDlgTitle";
  head.appendChild(title);
  const bodyEl = dom.mkEl("div");
  bodyEl.id = "mtDlgBody";
  const footEl = dom.mkEl("div");
  footEl.id = "mtDlgFoot";
  box.appendChild(head);
  box.appendChild(bodyEl);
  box.appendChild(footEl);
  host.appendChild(box);
  dom.body.appendChild(host);
  const DOC = {
    body: dom.body,
    createElement: (t) => dom.mkEl(t),
    createDocumentFragment: () => dom.mkEl("fragment"),
    getElementById: (id) => dom.DOC.getElementById(id),
    querySelector: (s) => dom.DOC.querySelector(s),
    querySelectorAll: (s) => dom.DOC.querySelectorAll(s),
  };
  const sandbox = {
    console: { log() {}, error() {} },
    document: DOC,
    I18n: { t: (k) => String(k) },
    setTimeout: () => 0,
    clearTimeout: () => {},
    closeTplSubOverlay: () => {},
  };
  const ctx = vm.createContext(sandbox);
  const SEG_FROM = APP.indexOf("let _mtDialogSeq = 0;");
  const SEG_TO = APP.indexOf("function nodeGuideId(node) {");
  ok(SEG_FROM > 0 && SEG_TO > SEG_FROM, "抠到 app.js 的 #mtDialog 段（_mtDialogSeq → nodeGuideId 之前）");
  try {
    vm.runInContext(APP.slice(SEG_FROM, SEG_TO), ctx, { filename: "app.js#mtDialog" });
    ok(true, "#mtDialog 段在假 DOM 里加载（无语法 / 顶层错误）");
  } catch (e) {
    ok(false, "#mtDialog 段加载失败：" + ((e && e.message) || e));
  }
  let p1 = null;
  let p2 = null;
  let resolved1 = "pending";
  p1 = vm.runInContext('promptDialog("改名", "旧名字");', ctx);
  p1.then((v) => {
    resolved1 = v === null ? "null" : JSON.stringify(v);
  });
  host.dispatch("keydown", { key: "a" }); /* 第一只窗的按键监听确实挂上了 */
  const input1 = bodyEl.querySelector(".mt-dialog-input");
  ok(!!input1 && input1.value === "旧名字", "第一只窗（promptDialog）把内容与输入框挂上了");
  const listenersBefore = (host._lis.keydown || []).length;
  ok(listenersBefore === 1, "此刻宿主上只有第一只窗的按键监听");

  p2 = vm.runInContext('confirmDialog("第二个窗来了");', ctx); /* 第二个窗顶掉第一个 */
  const listenersAfter = (host._lis.keydown || []).length;
  ok(listenersAfter === 1, "换窗后宿主上仍是 1 只监听（旧监听被摘、新监听已挂）");
  ok(bodyEl.querySelector(".mt-dialog-msg") !== null, "新窗内容已经铺上");

  let resolved2 = "pending";
  /* Esc 先按下去：此刻监听表里同时挂着旧窗与新窗两只（这正是「旧监听被摘、新监听还在」），
     顺带把新窗结算成 false；随后再挂 .then，微任务里读最终值 */
  host.dispatch("keydown", { key: "Escape", preventDefault() {} });
  p2.then((v) => {
    resolved2 = JSON.stringify(v);
  });

  asyncChecks.push(async () => {
    await Promise.resolve();
    ok(resolved1 === "null", "被顶掉的那只窗的 Promise 当场结算成 null（修复前：永久挂住）");
    ok(resolved2 === "false", "新窗自己照常结算（Esc → false），没被前一只窗的收尾牵连");
    ok((host._lis.keydown || []).length === 0, "新窗收尾后监听摘干净（不累积）");
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   [4] C：#overlay 开新窗 = 原地换窗（最小化已下线，不再有「收进状态栏」这一档）
   ════════════════════════════════════════════════════════════════════════════ */
console.log("\n[4] #overlay 开新窗：原地换窗（最小化 / 停放链已整体移除）");
has(APP, "function ovShellBox() {", "窗壳定位函数还在（closeOverlay 复用）");
ok(APP.indexOf("ovParkActiveBox") < 0, "ovParkActiveBox（开新窗前收旧窗）已删干净");
ok(
  APP.indexOf("function ovMinimizeActive(") < 0 &&
    APP.indexOf("function ovMinRestore(") < 0 &&
    APP.indexOf("const _ovMinList = ") < 0 &&
    APP.indexOf("let _ovMinSeq = ") < 0,
  "最小化状态机（_ovMinList / _ovMinSeq / ovMinimizeActive / ovMinRestore）已删干净",
);
{
  const oo = fnSrc(APP, "openOverlay");
  ok(oo.indexOf("ovShellEnsure()") > 0, "openOverlay 仍先取窗壳（原地接管同一只壳）");
  ok(oo.indexOf("ovParkActiveBox") < 0, "openOverlay 不再做任何停放动作（原地换窗）");
  ok(oo.indexOf("overlayClosable = opts.min !== false;") > 0, "opts.min 只剩「给不给通用 ✕」这一层语义");
  ok(oo.indexOf('$("#ovBody").innerHTML = "";') > 0 && oo.indexOf('$("#ovFoot").innerHTML = "";') > 0, "开新窗照旧清空正文与按钮条（旧窗内容当场作废）");
}
{
  const settleAt = NODES.indexOf("const settle = (ans, closeDom) => {");
  const settleEnd = NODES.indexOf("};", NODES.indexOf("resolve(ans);", settleAt));
  const settle = settleAt >= 0 && settleEnd > settleAt ? NODES.slice(settleAt, settleEnd) : "";
  ok(settle.length > 0, "抠到 confirmAssistAction 的 settle 收尾函数");
  ok(settle.indexOf("ovMinDropWindow") < 0, "确认框结算不再去摘页签（没有停放区了）");
  ok(settle.indexOf("closeDom && overlayIsMine()") > 0, "挂在 #overlay 上的那只照旧走 closeOverlay（原语义不变）");
}
{
  /* vm 真跑：连开两只窗 → 只有一只壳，第二只当场接管（旧内容不保留、不产生页签） */
  const dom = mkDom();
  const overlay = dom.mkEl("div");
  overlay.id = "overlay";
  const foot = dom.mkEl("footer");
  foot.className = "statusbar";
  dom.body.appendChild(overlay);
  dom.body.appendChild(foot);
  /* 与 index.html 的初始窗壳一致：首次 openOverlay 时应用里本来就挂着一只空壳 */
  const shell0 = dom.mkEl("div");
  shell0.className = "overlay-box";
  const h0 = dom.mkEl("div");
  h0.className = "overlay-head";
  const t0 = dom.mkEl("b");
  t0.id = "ovTitle";
  h0.appendChild(t0);
  const b0 = dom.mkEl("div");
  b0.className = "overlay-body";
  b0.id = "ovBody";
  const f0 = dom.mkEl("div");
  f0.className = "overlay-foot";
  f0.id = "ovFoot";
  shell0.appendChild(h0);
  shell0.appendChild(b0);
  shell0.appendChild(f0);
  overlay.appendChild(shell0);
  const DOC = {
    body: dom.body,
    createElement: (t) => dom.mkEl(t),
    createDocumentFragment: () => dom.mkEl("fragment"),
    getElementById: (id) => dom.DOC.getElementById(id),
    querySelector: (s) => dom.DOC.querySelector(s),
    querySelectorAll: (s) => dom.DOC.querySelectorAll(s),
  };
  const sandbox = {
    console: { log() {}, error() {} },
    document: DOC,
    I18n: { t: (k) => String(k) },
    S: { thinkOpen: null },
    $: (sel) => (String(sel).charAt(0) === "#" ? DOC.getElementById(String(sel).slice(1)) : DOC.querySelector(sel)),
    closeTplSubOverlay: () => {},
    setTimeout: (f) => {
      try {
        f();
      } catch (_) {}
      return 0;
    },
    clearTimeout: () => {},
    window: { innerWidth: 1600, innerHeight: 900 },
  };
  const ctx = vm.createContext(sandbox);
  const FROM = APP.indexOf("let overlayPersistent = false;");
  const TO = APP.indexOf("/* 独立于 #overlay 的深色确认");
  try {
    vm.runInContext(APP.slice(FROM, TO), ctx, { filename: "app.js#overlay" });
    ok(true, "#overlay 段在假 DOM 里加载");
  } catch (e) {
    ok(false, "#overlay 段加载失败：" + ((e && e.message) || e));
  }
  const R = (expr) => vm.runInContext(expr, ctx);
  ctx.openOverlay("设置 · APIs/Config", { persistent: true });
  const shellA = dom.DOC.querySelector("#overlay > .overlay-box");
  ok(!!shellA && overlay.children.length === 1, "第一只窗开起来（就地接管那只初始空壳，只留一只壳）");
  const bodyA = shellA.querySelector(".overlay-body");
  bodyA.appendChild(dom.mkEl("input"));
  bodyA.children[0].value = "用户填到一半的内容";

  ctx.openOverlay("确认画布修改", { persistent: true });
  const shellB = dom.DOC.querySelector("#overlay > .overlay-box");
  ok(shellB === shellA, "开第二只窗：还是同一只壳（原地换窗，不再搬走旧壳）");
  ok(overlay.children.length === 1, "蒙层下始终只有一只窗壳（没有停放区）");
  ok(
    dom.walk(foot).filter((e) => e.classList && e.classList.contains("ov-min-tab")).length === 0,
    "Footer 里没有任何最小化页签（那一排已整体移除）",
  );
  ok(
    (foot.children || []).filter((c) => c.id === "ovMinBar").length === 0,
    "Footer 里没有 #ovMinBar",
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   异步断言（Promise 结算发生在微任务里）+ 汇总
   ════════════════════════════════════════════════════════════════════════════ */
(async () => {
  for (const f of asyncChecks) await f();
  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过") + "  (smoke-ask-keep-input)");
  process.exit(fails ? 1 : 0);
})();
