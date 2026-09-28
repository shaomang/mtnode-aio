"use strict";
/* 长任务条带「按钮 hover 频繁闪烁」回归 —— 纯 Node，只读源码文本 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-longtask-hover.js
 *
 * 缺陷（本次需求）：长任务一跑起来，条带里的按钮 hover 时高频闪烁 —— 鼠标停在按钮上不动，
 * 它也在「亮 / 灭」之间跳。
 * 起因：ltRenderStrip() 每次重绘都把头部与左栏 SVG 整块重建（head.innerHTML = ""、
 * ltRenderGraph 重建整张 svg），而长任务运行期这条重绘非常密（Agent 每段流式正文都叫一次
 * ltRenderStripSoon，app-longtask.js 的 onEvent → 90ms 节流）。重建 = 鼠标底下那只 DOM
 * 被换掉，`:hover` 命中态每帧丢一次 —— 逐帧重复就是「频繁闪烁」；鼠标按在按钮上时新元素
 * 收不到 mouseup，这次 click 还会直接作废。头部那颗「⋯ 更多」下拉更惨：头部重建即被
 * ltMenuClose() 收掉，长任务跑着时点开都来不及点。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 判据就位：ltHoverKey / ltHoverNodeKey / ltHoverCapture / ltHoverApply / ltHoverBind
 *   [2] key 口径（vm 真跑）：图节点按 data-lt-id、端子 / 缩放手柄各带后缀、
 *       普通按钮按可点件类 + 文案；采集只留指针底下非空的那些 key
 *   [3] 重建后补标（vm 真跑 ltRenderStrip）：指针压在头部按钮 / 图节点 / 端子上时，
 *       重建出来的新元素带上 data-hover；指针不在条带里时一个标都不补
 *   [4] CSS 口径：这一族可点件的悬停态写成 `:hover, [data-hover]`（两路同一份值）
 *   [5] 「⋯ 更多」下拉不再被头部重建收掉：锚点身份 data-lt-menu + 重建后 ltMenuReadopt
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const LTU = read("renderer/app-longtask-ui.js");
const LTC = read("renderer/css/longtask.css");

function fnBody(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(m.index + 1, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}
/* 函数全文（到第 0 列的那个收尾大括号为止）。/["\\]/ 这类带引号的正则字面量会让上面那个
   朴素括号计数器把字符串态判错，纯文本断言一律走这一份，不拿 fnBody 去切。 */
function fnSrc(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const rest = src.slice(m.index);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end + 3);
}

/* ── 迷你 DOM：够这条判据用（classList / 属性表 / children / parentNode / 递归遍历），
      并集 ＝ HTML 元素（head 里那批 button）与 SVG 元素（图节点 g / 端子 circle）两种 ── */
function mkEl(cls, attrs) {
  const el = {
    nodeType: 1,
    tagName: "DIV",
    className: cls || "",
    children: [],
    parentNode: null,
    attrs: Object.assign({}, attrs || {}),
    textContent: "",
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    /* 可点件判定用的是 closest——迷你元素照真元素给一份（只认选择器表里那几类：标签名与类名） */
    closest(sel) {
      for (const part of String(sel).split(",")) {
        const s = part.trim().toLowerCase();
        if (!s) continue;
        if (s.charAt(0) === ".") {
          if (String(this.className).split(/\s+/).indexOf(s.slice(1)) >= 0) return this;
        } else if (s === String(this.tagName || "").toLowerCase()) return this;
      }
      return null;
    },
    appendChild(c) {
      if (c && c.parentNode) c.parentNode.removeChild(c);
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    contains(t) {
      let p = t;
      while (p) {
        if (p === this) return true;
        p = p.parentNode;
      }
      return false;
    },
  };
  el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set() {
      this._cleared = (this._cleared || 0) + 1;
      for (const c of this.children.slice()) this.removeChild(c);
    },
  });
  return el;
}
function mkBtn(cls, txt) {
  const b = mkEl(cls);
  b.tagName = "BUTTON";
  b.textContent = txt;
  return b;
}
function walkAll(root, out) {
  out = out || [];
  for (const c of root.children || []) {
    out.push(c);
    walkAll(c, out);
  }
  return out;
}
function withDataHover(root) {
  return walkAll(root).filter((n) => n.getAttribute("data-hover") === "1");
}
/* 状态机图里的一个节点卡片 + 端子（结构照 ltRenderGraph：g.lt-nd[data-lt-id] > circle.lt-port） */
function mkGraphNode(id) {
  const g = mkEl("lt-nd lt-k-agent");
  g.tagName = "G";
  g.setAttribute("data-lt-id", id);
  const port = mkEl("lt-port");
  port.tagName = "CIRCLE";
  g.appendChild(port);
  return { g, port };
}

console.log("\n[1] 悬停保护判据就位（renderer/app-longtask-ui.js）");
{
  for (const n of ["ltHoverNodeKey", "ltHoverKey", "ltHoverCapture", "ltHoverApply", "ltHoverBind"])
    ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
  ok(LTU.indexOf("ltHoverCapture(LT_UI.body)") > 0 && LTU.indexOf("ltHoverHere();") > 0, "ltRenderStrip 重建前后各走一步（先采一帧、建完补标）");
  ok(fnSrc(LTU, "ltRenderStrip").indexOf("ltHoverBind()") > 0, "重绘入口顺手挂上指针监听（pointermove 一移就抹标）");
  ok(/pointermove/.test(fnSrc(LTU, "ltHoverBind")) && /data-hover/.test(fnSrc(LTU, "ltHoverBind")), "指针一动就把上一帧的标清掉（悬停态只由「此刻指针在哪」决定）");
}

console.log("\n[2] key 口径（vm 真跑）");
{
  const sb = { console, Array, Object, String, Number, isFinite };
  vm.createContext(sb);
  for (const n of ["ltHoverNodeKey", "ltHoverKey"]) vm.runInContext(fnBody(LTU, n), sb);
  vm.runInContext("globalThis.DOC = { elementFromPoint: function () { return null; } };", sb);
  const key = (el) => vm.runInContext("ltHoverKey", sb)(el);

  const n1 = mkGraphNode("n_a1");
  ok(key(n1.g) === "lt-nd:@n_a1", "图节点卡片：key = 节点 data-lt-id（与这一帧长什么样无关）");
  ok(key(n1.port) === "lt-nd:|port@n_a1", "端子：并上「是哪一件」，指针从端子移到卡片不会被当成同一件");
  const rs = mkEl("lt-nd-resize");
  n1.g.appendChild(rs);
  ok(key(rs) === "lt-nd:|resize@n_a1", "缩放手柄：同样带后缀（它是卡片组里的独立 rect）");
  const noId = mkEl("lt-nd");
  ok(key(noId) === "", "没有 data-lt-id 的卡片不给 key（不按没有身份的东西补标）");

  const stop = mkBtn("lt-btn lt-btn-pri", "■ 停止");
  ok(key(stop) === "lt-el:■ 停止", "普通按钮：按可点件类 + 文案取身份");
  const more = mkBtn("lt-btn lt-more", "⋯ 更多");
  ok(key(more) === "lt-el:⋯ 更多", "头部按钮同样认得出（文案就是它的身份）");
  const chip = mkEl("lt-chip lt-chip-wait");
  chip.textContent = "等你处理 ×2";
  ok(key(chip) === "lt-el:等你处理 ×2", "可点的状态胶囊：key 取它自己的文案（点击落点可能是不带按钮结构的 span）");
  const cardBtn = mkBtn("lt-btn", "通过");
  const card = mkEl("lt-mem-i");
  card.appendChild(cardBtn);
  ok(key(card) === "" && key(cardBtn) === "lt-el:通过", "非可点容器不给 key、里面的按钮照给（补标只落在真正匹配的那一件上）");
}

console.log("\n[3] 重建后补标（vm 真跑 ltRenderStrip）");
{
  const body = mkEl("lt-body");
  const head = mkEl("lt-head");
  const main = mkEl("lt-main");
  body.appendChild(head);
  body.appendChild(main);
  const doc = {
    listeners: [],
    activeElement: null,
    body: mkEl(""),
    documentElement: mkEl(""),
    addEventListener(type, fn) {
      this.listeners.push({ type, fn });
    },
    removeEventListener() {},
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
  };
  doc.body.tagName = "BODY";
  doc.documentElement.tagName = "HTML";
  /* 指针底下的那一件：由每轮的 hit 决定（模拟「鼠标停着不动、条带每 ~90ms 重建一次」） */
  const hit = { el: null };
  doc.elementFromPoint = () => hit.el;
  let graphNode = null;
  const sb = {
    console,
    Array,
    Object,
    String,
    Number,
    Date,
    Math,
    JSON,
    isFinite,
    parseFloat,
    parseInt,
    document: doc,
    /* 滚动保护的两张表（本次需求）：照源码那一份建空表（Object.create(null)）—— 本档不验
     滚动位置，只保证 ltRenderStrip 收尾那一步找得到表、不抛异常。 */
    LT_SCROLL: Object.create(null),
    LT_SCROLL_SUB: Object.create(null),
    LT_UI: { body, head, main, grip: mkEl("lt-grip") },
    ltHoverBound: false,
    ltHoverX: 300,
    ltHoverY: 40,
    ltHoldColEl: null,
    ltRenderWait: false,
    S: { wf: { id: "wf1" } },
    ltGripSync: () => {},
    ltEnsure: () => {},
    ltMenuClose: () => {},
    ltMenuReadopt: () => {},
    LT_MENU: null,
    ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
    ltEnabledTask: () => null,
    ltCurrentRun: () => null,
    ltValidate: () => [],
    ltMemPendingCount: () => 0,
    /* 条带头那一枚「当前选型」chip（ltRenderHead 里新加的只读回显）：本档只验悬停补标，
       回显四件套按「拿不到清单」的空态桩掉 —— 真行为由 smoke-longtask-model.js 钉。 */
    ltAgentOptsNow: () => null,
    ltAgentSelRead: () => ({ provider: "", model: "", preset: "", effort: "" }),
    ltAgentSelParts: () => ({ route: "", model: "", preset: "", effort: "" }),
    ltAgentSelText: () => "",
    ltAgentModelShort: () => "",
    ltEl: (tag, cls, txt) => {
      const e = mkEl(cls || "");
      e.tagName = String(tag || "div").toUpperCase();
      if (txt != null) e.textContent = String(txt);
      return e;
    },
    ltBtn: (text, cls) => mkBtn("lt-btn " + (cls || ""), text),
    ltStatusChip: () => mkEl("lt-chip lt-chip-run"),
    ltMoreBtn: () => mkBtn("lt-btn lt-more", "⋯ 更多"),
    ltT: (t) => t,
    ltEmptyState: () => mkEl("lt-empty"),
    ltColOf: () => null,
    ltColHold: () => false,
    ltFocusCol: () => false,
    ltEditHost: () => null,
    ltFocusInside: () => false,
    ltSelInCol: () => false,
    ltRenderWhenFocusLeaves: () => {},
    ltRenderSide: () => {},
    /* 按住保护（本次需求）：本档只验悬停补标，按住态一律当「没按着」（真行为由
       smoke-longtask-strip-hold.js 钉）。 */
    ltStripHold: { el: null, at: 0 },
    ltRenderGraph: (left) => {
      const node = mkGraphNode("n_a1");
      graphNode = node;
      left.appendChild(node.g);
    },
  };
  vm.createContext(sb);
  for (const n of [
    "ltHoverNodeKey",
    "ltHoverKey",
    "ltHoverCapture",
    "ltHoverApply",
    "ltHoverBind",
    "ltHoverHere",
    "ltRenderStrip",
    "ltRenderHead",
    "ltRenderMain",
    "ltRenderFlushDeferred",
    "ltRenderWhenFocusLeaves",
    /* 按住保护与滚动保护（本次需求）：本档只验悬停补标，这两个直接跑真身即可 ——
       「没按着」走 ltStripHoldNow，栏位登记走 ltTrackCols，都不会碰悬停标。 */
    "ltStripOf",
    "ltStripHoldNow",
    "ltStripHoldRelease",
    "ltDeferBecauseHold",
    "ltTrackCols",
    "ltScrollTopNow",
    "ltScrollHNow",
    "ltScrollCHNow",
    "ltScrollKeyOf",
    "ltScrollSave",
    "ltScrollRestore",
    "ltScrollCollect",
    "ltScrollSaveSub",
    "ltScrollRestoreSub",
    "ltScrollSnapshot",
    "ltScrollApply",
    "ltScrollRebind",
  ])
    vm.runInContext(fnBody(LTU, n), sb);
  doc.listeners = [];
  const render = () => vm.runInContext("ltRenderStrip()", sb);
  const headBtn = () => head.children.filter((c) => c.tagName === "BUTTON")[0] || null;

  /* A. 指针压着头部按钮：重建后新按钮同样带悬停标（这正是「闪烁」的那一件） */
  hit.el = null;
  render();
  const b1 = headBtn();
  ok(!!b1 && b1.getAttribute("data-hover") === null, "第一帧（指针还不在条带里）不补任何标");
  hit.el = b1;
  render();
  const b2 = headBtn();
  ok(b2 !== b1 && b2.getAttribute("data-hover") === "1", "指针停在头部按钮上 → 重建出来的新按钮带上 data-hover（悬停态不再每 90ms 丢一帧）");
  ok(withDataHover(body).length === 1, "只给真正匹配的那一件补标（不传播到别的按钮）");

  /* B. 指针压着图节点 / 端子：左栏 SVG 整张重建，节点与端子照样补得上 */
  hit.el = null;
  render();
  hit.el = graphNode.g;
  render();
  ok(graphNode.g.getAttribute("data-hover") === "1", "指针停在图节点上 → 新节点卡片补标（悬停态续到重建出来的那一张上）");
  hit.el = graphNode.port;
  render();
  ok(graphNode.port.getAttribute("data-hover") === "1" && graphNode.g.getAttribute("data-hover") === "1", "指针停在端子上 → 新端子与它所属卡片都补标（端子悬停不会闪）");

  /* C. 指针移开（elementFromPoint 落空 = 指针不在条带里）：一个标都不补 */
  hit.el = null;
  render();
  ok(withDataHover(body).length === 0, "指针不在条带里 → 不补标（悬停态不会粘在重建后的新件上）");

  /* D. 监听真挂上了：pointermove 一移就抹掉旧标 */
  ok(doc.listeners.filter((l) => l.type === "pointermove").length === 1, "只挂一条 pointermove 监听（反复重绘不会越挂越多）");
  const hovered = mkBtn("lt-btn", "占位");
  hovered.setAttribute("data-hover", "1");
  head.appendChild(hovered);
  doc.querySelectorAll = () => [hovered];
  const move = doc.listeners.filter((l) => l.type === "pointermove")[0];
  move.fn({ clientX: 120, clientY: 33 });
  ok(hovered.getAttribute("data-hover") === null, "指针一动就抹标（并且顺手记下新的指针坐标）");

  /* E. 焦点保护那两条早退路也要补标：右栏正在打字时左栏重建，悬停态不能顺手丢掉 */
  ok((fnSrc(LTU, "ltRenderMain").match(/ltHoverHere\(\)/g) || []).length >= 4, "ltRenderMain 的四条出口（空态 / 留右栏 / 留左栏 / 整块重建）都走补标，早退路不漏");
  ok(fnBody(LTU, "ltRenderStrip").indexOf("ltHoverHere()") > 0, "strip 那一层重建后也补标（head 被换掉的那些件在这里续上）");
  ok(fnSrc(LTU, "ltRenderStrip").indexOf("LT_UI.hoverKeys = typeof ltHoverCapture === \"function\" ? ltHoverCapture(LT_UI.body) : []") > 0, "采集在任何 DOM 被换掉之前落进 LT_UI.hoverKeys（各条重建路共用这一份）");
}

console.log("\n[4] CSS：悬停态写成 `:hover, [data-hover]` 两路（本次需求的真正落点）");
{
  /* 取一条规则的选择器文本（第一个 { 之前的那段），逐个看它有没有把两路并在一起 */
  const sels = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(LTC))) sels.push(m[1].trim());
  const hasBoth = (frag) =>
    sels.some((s) => s.indexOf(frag) >= 0 && s.indexOf(":hover") >= 0 && s.indexOf("[data-hover]") >= 0);
  const pairs = [
    [".lt-btn:hover", ".lt-btn", "通用按钮（头部「■ 停止 / ✎ 修改任务链 / ⚙ / ✕」与右栏按钮都在这一族）"],
    [".lt-btn-pri:hover", ".lt-btn-pri", "主按钮（「＋ 创建长任务 / ▶ 继续」）"],
    [".lt-btn-force:hover", ".lt-btn-force", "「⏭ 强行进入下一状态」（本次需求：run 停在手上时的出路）"],
    [".lt-head .lt-btn.on", ".lt-head .lt-btn", "头部按钮的悬停 / 展开态"],
    [".lt-chip-wait:hover", ".lt-chip-wait", "状态胶囊「等你处理 ×N」（可点）"],
    [".lt-chip-mem:hover", ".lt-chip-mem", "状态胶囊「待确认记忆 ×N」（可点）"],
    [".lt-crumb-i:hover", ".lt-crumb-i", "面包屑条目"],
    [".lt-btn-zoom:hover", ".lt-btn-zoom", "缩放回显（点一下回 100%）"],
    [".lt-port:hover", ".lt-port", "状态机图端子"],
    [".lt-nd rect.lt-nd-resize:hover", ".lt-nd rect.lt-nd-resize", "节点缩放手柄"],
    [".lt-sel-o:hover", ".lt-sel-o", "可搜索下拉的选项"],
    [".lt-sel-tagx:hover", ".lt-sel-tagx", "多选芯片的 ✕"],
  ];
  for (const [frag, keep, label] of pairs) {
    ok(LTC.indexOf(frag) > 0, frag + " 仍在（" + label + "）");
    ok(hasBoth(keep + ":hover"), label + "：`:hover` 与 `[data-hover]` 并排写（重建后的补标与真 hover 同一份值）");
  }
  ok(/data-hover/.test(LTC) && LTC.indexOf("ltHoverKey") > 0, "样式里写清了这套标的来处（app-longtask-ui.js 的 ltHoverKey 一族）");
}

console.log("\n[5] 「⋯ 更多」下拉不再被头部重建收掉");
{
  const headBody = fnSrc(LTU, "ltRenderHead");
  ok(headBody.indexOf("data-lt-menu") > 0 && headBody.indexOf("ltMenuReadopt(") > 0, "头部重建后按锚点身份把下拉认回来（以前一律 ltMenuClose，长任务跑着时点开就被收）");
  /* 只认「真的调了一次」的语句形态：注释里提到 ltMenuClose() 是说明，不是行为。
     例外（本轮口径）：模型 chip 的「再点一次自身即收」也是**在 onclick 里**收掉自己刚开的
     那一只面板 —— 它是点击手势的续写（紧跟 return），不是「重建时无条件收菜单」。
     所以判据收紧成「没有不跟 return 的裸 ltMenuClose();」：老那种无条件收仍然判失败。 */
  const bare = headBody.match(/ltMenuClose\(\s*\)\s*;(?!\s*return)/g) || [];
  ok(bare.length === 0, "ltRenderHead 不再无条件收菜单（只有认不到锚点才由 ltMenuReadopt 收；chip 的「再点一次自身即收」是手势续写，不算）");
  ok(LTU.indexOf('b.setAttribute("data-lt-menu", "lt-more")') > 0, "「⋯ 更多」按钮写下锚点身份（与按钮形状无关，重建后仍找得到）");
  const readopt = fnSrc(LTU, "ltMenuReadopt");
  ok(/ltMenuClose\(\s*\)\s*;/.test(readopt) && readopt.indexOf("ltMenuPlace(") > 0, "认不到锚点就收掉、认到就重新贴位（绝不留一只锚点已失效的浮层）");
  ok(LTU.indexOf("\nfunction ltMenuPlace(") > 0 && fnSrc(LTU, "ltMenuOpen").indexOf("ltMenuPlace(") > 0, "贴位逻辑抽成 ltMenuPlace，开菜单与重建后认锚点共用一份（不会两处各写一套溢出回收）");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-hover)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-hover)",
);
process.exit(fails ? 1 : 0);