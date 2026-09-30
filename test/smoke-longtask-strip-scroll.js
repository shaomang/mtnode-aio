"use strict";
/* 长任务条带「滚动位置自动弹回 + 按钮按不动」回归 —— 纯 Node，只读源码文本 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-longtask-strip-scroll.js
 *
 * 缺陷（本次需求，读作一条）：
 *   ① 文本框 / 右栏无法下拉：内容比可视区高，用户往下滚着看，滚一会儿迎面一股力把它顶回
 *      顶上 —— 手一停就往回弹（「会自动弹回」）；
 *   ② 长任务执行过程中，按钮等 UI 悬停时疯狂闪烁、**按不动**。
 * 同一个根因：条带在运行期被 ltRenderStrip() 整块重建（Agent 每段流式正文都叫一次
 * ltRenderStripSoon，app-longtask.js 的 onEvent → 90ms 节流）。重建 = 两栏 / 头部 / 多行框
 * 换了一批新 DOM：新栏 scrollTop = 0（阅读位置丢）、鼠标底下那一件被换掉（:hover 丢一帧
 * 就是「闪烁」，mouseup 落不到新元素上就是「按不动」）。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 滚动保护机制就位：LT_SCROLL / LT_SCROLL_SUB + 采帧 / 贴回一族
 *   [2] key 口径（vm 真跑）：两栏 / 头部按栏名，多行框按 data-lt-scroll / data-lt-hk
 *   [3] 真跑：重建后滚到哪儿还停在哪儿（两栏 + 多行框），没滚过的格一个字节都不写
 *   [4] 按住保护（vm 真跑）：按在可点件上 → 整条条带冻住；按在输入框 / 条带外 → 不冻
 *   [5] 接线：ltRenderStrip 采帧→重建→贴回；ltRenderMain 三条路都登记当下两栏；
 *       ltHoldBind 松手时先放栏再放条带（那一次被推迟的重绘才落得下去）
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
const CSS = read("renderer/css/longtask.css");

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
/* 函数全文（到第 0 列那个收尾大括号为止）：纯文本断言专用 */
function fnSrc(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const rest = src.slice(m.index);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end + 3);
}

/* ── 迷你 DOM：够本档用（classList / 属性表 / children / 滚动几何 / closest / contains）── */
function mkEl(tag, cls) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    className: cls || "",
    children: [],
    parentNode: null,
    attrs: {},
    textContent: "",
    value: "",
    style: {},
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    handlers: {},
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    removeEventListener() {},
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
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
    querySelectorAll(sel) {
      const out = [];
      const keys = String(sel)
        .split(",")
        .map((s) => s.trim().replace(/^\[|\]$/g, ""))
        .filter(Boolean);
      const walk = (n) => {
        for (const c of n.children) {
          if (keys.some((k) => c.getAttribute(k) != null)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    emit(type, ev) {
      for (const fn of (this.handlers[type] || []).slice()) fn(ev || {});
    },
  };
  el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
  /* 「还挂在文档里吗」：真 DOM 有这个布尔值，迷你环境照给一份 —— 按住保护那一档
     （ltStripHoldNow）正是拿它判「按下那一件有没有被换掉」。根节点（本档自己造的那棵
     树的顶）= 视为已连接；被摘出（removeChild）的子树自然为 false。 */
  Object.defineProperty(el, "isConnected", {
    get() {
      let p = this;
      let hops = 0;
      while (p) {
        if (p.parentNode == null) return hops > 0; /* 不是孤零零一个 = 挂在某棵树上 */
        p = p.parentNode;
        hops++;
      }
      return false;
    },
  });
  return el;
}
function sandboxFor(names, extra) {
  const sb = Object.assign(
    {
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
      LT_SCROLL: Object.create(null),
      LT_SCROLL_SUB: Object.create(null),
    },
    extra || {},
  );
  vm.createContext(sb);
  for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
  return sb;
}
/* 一只「能滚的块」：可视高 h、内容高 ch，scrollTop 由测试写 */
function scroller(cls, h, ch, top) {
  const el = mkEl("div", cls);
  el.clientHeight = h;
  el.scrollHeight = ch;
  el.scrollTop = top || 0;
  return el;
}
const SCROLL_FNS = [
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
  "ltScrollBind",
];

console.log("\n[1] 滚动保护机制就位（renderer/app-longtask-ui.js）");
{
  ok(
    /const LT_SCROLL = Object\.create\(null\);/.test(LTU) && /const LT_SCROLL_SUB = Object\.create\(null\);/.test(LTU),
    "两张表：栏位一处（LT_SCROLL）、栏内小块一处（LT_SCROLL_SUB，永不互相覆盖）",
  );
  for (const n of ["ltScrollTopNow", "ltScrollHNow", "ltScrollCHNow", "ltScrollKeyOf", "ltScrollSave", "ltScrollRestore", "ltScrollCollect", "ltScrollSaveSub", "ltScrollRestoreSub", "ltScrollSnapshot", "ltScrollApply", "ltScrollRebind", "ltScrollBind"])
    ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
  const strip = fnSrc(LTU, "ltRenderStrip");
  ok(strip.indexOf("ltScrollSnapshot()") > 0 && strip.indexOf("ltScrollRebind(scrollSnap)") > 0, "ltRenderStrip：重建前采一帧、收尾贴回（同一个函数内，重建各条早退路都盖得住）");
  ok(LTU.indexOf("ltScrollSnapshot()") < LTU.indexOf("ltScrollRebind(scrollSnap)"), "顺序对：先采后贴（反了就等于没记）");
  ok(fnSrc(LTU, "ltRenderMain").indexOf("ltTrackCols(") > 0, "ltRenderMain 的早退路与整块重建都把当下两栏登记给 LT_UI（贴回时按栏名找回新元素）");
  ok(/LT_UI\.right|ltTrackCols/.test(fnSrc(LTU, "ltScrollRebind")), "ltScrollRebind 从 LT_UI 取**新**的那一栏（不是快照里已摘出文档的旧节点）");
  ok(fnSrc(LTU, "ltTaHApply").indexOf("data-lt-scroll") > 0, "多行框重建时顺手写滚动 key（与草稿 / 高度表同键）");
  ok(fnSrc(LTU, "ltInput").indexOf("ltInputScrollKey(i, label)") > 0, "没给 hkey 的多行框也有稳定 key（不是只保「目标 / 说明」一格）");
  ok(fnSrc(LTU, "ltInputScrollKey").indexOf("ltScrollScopeOf") > 0, "key 按「属于谁 + 字段名」拼（跨检查器不串台）");
  ok(/overflow:\s*auto/.test(CSS.slice(CSS.indexOf(".lt-right {"))) || /\.lt-right\s*\{[^}]*overflow:\s*auto/.test(CSS), ".lt-right 仍是 overflow:auto 的滚动容器（本需求只是保住它的位置）");
}

console.log("\n[2] key 口径（vm 真跑）");
{
  const sb = sandboxFor(["ltScrollKeyOf"]);
  const key = (el, k) => vm.runInContext("ltScrollKeyOf", sb)(el, k);
  ok(key(scroller("lt-right", 300, 900, 200)) === "col:lt-right", "右栏按栏名记（'col:lt-right'）");
  ok(key(scroller("lt-left", 300, 900, 0)) === "col:lt-left", "左栏同理");
  ok(key(scroller("lt-head", 30, 400, 120)) === "col:lt-head", "头部那一行横向滚也按栏名记");
  const ta = scroller("lt-in", 66, 300, 40);
  ta.setAttribute("data-lt-hk", "/n_a1:goal");
  ok(key(ta, "") === "ta:/n_a1:goal", "多行框：与草稿 / 高度表同键（data-lt-hk → ta:<key>）");
  const block = scroller("lt-mem-list", 200, 800, 300);
  block.setAttribute("data-lt-scroll", "col:lt-mem-list");
  ok(key(block, "") === "col:lt-mem-list", "自带滚动条的小块优先认自己的 data-lt-scroll 标记");
  const plain = scroller("lt-fh", 200, 800, 300);
  ok(key(plain, "") === "", "没有身份的小块不给 key（宁可这次不保，也不乱记）");
  ok(key(scroller("lt-in", 33, 200, 10), "ta:explicit") === "ta:explicit", "显式 key 优先（调用处说了算）");
}

console.log("\n[3] 真跑：重建后滚到哪儿还停在哪儿");
{
  const sb = sandboxFor(SCROLL_FNS);
  const right = scroller("lt-right", 300, 1200, 420);
  const head = scroller("lt-head", 30, 900, 260);
  const ta = scroller("lt-in", 66, 400, 120);
  ta.setAttribute("data-lt-hk", "/n_a1:goal");
  right.appendChild(ta);
  const ui = { right, head, left: null };
  sb.LT_UI = ui;
  const snap = () => vm.runInContext("ltScrollSnapshot()", sb);
  const rebind = (s) => vm.runInContext("ltScrollRebind", sb)(s);

  /* 第一帧：用户滚到 420 / 260 / 120 */
  const s1 = snap();
  /* 整块重建：新长出来的三件都是干净的（scrollTop = 0） */
  const right2 = scroller("lt-right", 300, 1200, 0);
  const head2 = scroller("lt-head", 30, 900, 0);
  const ta2 = scroller("lt-in", 66, 400, 0);
  ta2.setAttribute("data-lt-hk", "/n_a1:goal");
  right2.appendChild(ta2);
  ui.right = right2;
  ui.head = head2;
  rebind(s1);
  ok(right2.scrollTop === 420, "右栏重建后仍停在 420（「自动弹回」被治住）");
  ok(head2.scrollTop === 260, "头部横向位置同样保住");
  ok(ta2.scrollTop === 120, "多行框自己那条滚动条也保住（框内滚到哪儿还停在哪儿）");

  /* 用户又往下滚了一点：下一帧采到的必须是**此刻**的值（不是上一轮记的） */
  right2.scrollTop = 700;
  ui.right = right2;
  const s2 = snap();
  const right3 = scroller("lt-right", 300, 1200, 0);
  ui.right = right3;
  rebind(s2);
  ok(right3.scrollTop === 700, "再滚一次 → 记的是新的那一份（老值不粘住）");

  /* 用户自己滚回顶上：不记（新内容长出来后不许按老位置把它钉在半空） */
  right3.scrollTop = 0;
  const s3 = snap();
  const right4 = scroller("lt-right", 300, 2400, 0);
  ui.right = right4;
  rebind(s3);
  ok(right4.scrollTop === 0, "滚回顶上 = 不记：内容变高后新栏照旧从头开始（不凭空停在半空）");

  /* 内容明显变高时的换算：不越界（新内容更矮时也不把画面滚出内容外） */
  const tall = scroller("lt-right", 300, 1200, 600);
  ui.right = tall;
  const s4 = snap();
  const short = scroller("lt-right", 300, 330, 0);
  ui.right = short;
  rebind(s4);
  ok(short.scrollTop <= 30, "新内容只剩 330（可视 300）→ 位置被夹在内容的真实末尾（不会滚到空气里）");
}

console.log("\n[4] 按住保护：鼠标还按在可点件上时，条带这一帧一次都不重建（vm 真跑）");
/* 假钟：TTL 用例把时间往前拨，不真等 1.2 秒 */
let FAKE_NOW = 1_000_000_000;
{
  const strip = mkEl("div", "lt-strip");
  const head = mkEl("div", "lt-head");
  const btn = mkEl("button", "lt-btn");
  btn.tagName = "BUTTON";
  const ta = mkEl("textarea", "lt-in");
  const outside = mkEl("div", "");
  head.appendChild(btn);
  strip.appendChild(head);
  strip.appendChild(ta);
  const sb = sandboxFor(["ltEditHost", "ltStripOf", "ltStripHoldArm", "ltStripHoldNow", "ltStripHoldRelease", "ltDeferBecauseHold"], {
    LT_UI: { strip },
    ltStripHold: { el: null, at: 0 },
    ltRenderWhenFocusLeaves: () => {},
    ltRenderFlushDeferred: () => {},
    /* 本轮需求：按住保护自带 TTL（鼠标松开那一下落到真浏览器窗口上时不许悬挂）。
       这里补上模块级常量 + 一盏假钟，把「按下 → 过 TTL」这条路走真。 */
    LT_STRIP_HOLD_TTL: 1200,
    Date: { now: () => FAKE_NOW },
  });
  const arm = (el) => vm.runInContext("ltStripHoldArm", sb)(el);
  const now = () => vm.runInContext("ltStripHoldNow()", sb);
  const release = () => vm.runInContext("ltStripHoldRelease()", sb);

  ok(now() === false, "一开始没按着 → 不冻（条带照常跟着运行态刷新）");
  arm(btn);
  ok(now() === true, "按下头部按钮 → 整条条带冻住：mouseup 一定落回原来那一件（click 不作废）");
  ok(vm.runInContext("ltDeferBecauseHold()", sb) === true, "这一帧的重绘被推迟（记下「稍后补一次」，不是丢掉）");
  release();
  ok(now() === false, "松手 → 解冻（被推迟的那一次重绘立刻兑现）");
  arm(ta);
  ok(now() === false, "按在输入框里 → 不走这条（打字 / 框选由 ltColHold 按栏保留，语义不同）");
  arm(outside);
  ok(now() === false, "按在条带外面（画布 / 别的浮层）→ 不冻（与条带无关的按下绝不牵连）");
  arm(btn);
  btn.parentNode.removeChild(btn); /* 那一件被别处换掉了（切画布 / 条带收起） */
  ok(now() === false, "按下那一件已不在文档里 → 自动放行（绝不留成悬挂、把界面长期冻死）");

  /* 本轮需求：鼠标松开那一下**没到达本窗口**（真浏览器窗口抢走前台，pointerup 落到别人
     身上）时，按住态不许悬挂 —— 悬挂 = 条带再也不重绘 = 用户看到的「按钮都在、点了没反应」。
     口径：按住态自带 TTL，超过它按「松手丢了」处理（放行 + 兑现被推迟的那次重绘）。 */
  /* 重新拿回那一件（上面把它摘出文档了）：另起一只挂在条带里的按钮 */
  const btn2 = mkEl("button", "lt-btn");
  btn2.tagName = "BUTTON";
  head.appendChild(btn2);
  FAKE_NOW = 2_000_000_000;
  arm(btn2);
  ok(now() === true, "刚按下：正常冻住（这一次 click 必须落到原来那一件上）");
  FAKE_NOW += 300;
  ok(now() === true, "300ms：还在 TTL 内 → 照旧冻着（不是一按就放）");
  FAKE_NOW += 2000;
  ok(now() === false, "超过 TTL（1.2s）：松手那一下丢了也放行 —— 条带不会因为一次丢事件长期冻死");
  ok(
    vm.runInContext("ltStripHold.el", sb) === null,
    "放行时按住态被真正清掉（不是每次判据里假装 false）",
  );
  ok(
    /LT_STRIP_HOLD_TTL/.test(LTU) && /Date\.now\(\) - h\.at > LT_STRIP_HOLD_TTL/.test(fnBody(LTU, "ltStripHoldNow")),
    "TTL 判据写在 ltStripHoldNow 里（唯一的「冻不冻」出入口）",
  );
  /* 窗口重新拿到焦点 = 用户回来了：再收一次可能是丢了 mouseup 的按住态，
     他回来点的第一下要落在活界面上（接线在 ltHoldBind） */
  const bindFocus = fnSrc(LTU, "ltHoldBind");
  ok(/addEventListener\("focus"/.test(bindFocus) && /addEventListener\("blur"/.test(bindFocus),
    "ltHoldBind：失焦与重新获焦都收一次按住态（丢 mouseup 的那种悬挂在这里自愈）");
  ok(
    fnSrc(LTU, "ltHoldArm").indexOf("ltHoldTtl") > 0 && fnSrc(LTU, "ltHoldRelease").indexOf("ltHoldTtl") > 0,
    "右栏「栏内按住」保护同样有 TTL 兜底（同一个病，同一条药）",
  );

  /* 接线：松手时先放栏、再放条带（顺序反了那一次重绘会在栏还占着时落空） */
  const bind = fnSrc(LTU, "ltHoldBind");
  ok(bind.indexOf("ltHoldRelease();") < bind.indexOf("ltStripHoldRelease()"), "pointerup 先 ltHoldRelease 再 ltStripHoldRelease（同一轮里两次都放掉，重绘才落得下去）");
  ok(fnSrc(LTU, "ltRenderStrip").indexOf("ltStripHoldNow()") > 0, "ltRenderStrip 第一道闸就是按住保护（整块早退，一个 DOM 都不拆）");
  ok(fnSrc(LTU, "ltColHoldNow").indexOf("ltStripHoldNow()") > 0, "ltColHoldNow 同样认这条：按住期间不兑现被推迟的那次重绘");
}

console.log("\n[5] 真跑：老栏被摘出文档（浏览器把它的 scrollTop 归零）也不丢位置");
{
  /* 本次需求的根因就在这一格：上面 [3] 是「换一只新元素、老元素自己还留着位置」，
     真实浏览器不是那样 —— ltRenderMain 一拆旧栏（removeChild），旧栏连同栏内所有
     自带滚动条的小块，scrollTop 立刻被归零。收尾若还去读旧元素（旧写法在
     ltScrollRebind 里调 ltScrollApply），读到的就是 0，刚记下的位置被当成
     「用户自己滚回顶上了」删掉，新栏于是永远停在顶上；条带约 90ms 重绘一次，
     于是「手一停就被顶回顶上」反复发生（实测：removeChild 后 scrollTop 360 → 0）。
     口径：位置在**采帧**那一刻就落表（那时元素还活着），收尾只负责贴回新元素。 */
  const sb = sandboxFor(SCROLL_FNS);
  const right = scroller("lt-right", 300, 1200, 460);
  const ta = scroller("lt-in", 66, 400, 130);
  ta.setAttribute("data-lt-hk", "/n_a1:goal");
  right.appendChild(ta);
  const ui = { right, head: scroller("lt-head", 30, 900, 0), left: null };
  sb.LT_UI = ui;
  const snap = () => vm.runInContext("ltScrollSnapshot()", sb);
  const rebind = (s) => vm.runInContext("ltScrollRebind", sb)(s);
  const recorded = (k) => vm.runInContext('LT_SCROLL["' + k + '"] ? LT_SCROLL["' + k + '"].top : null', sb);

  const s = snap();
  ok(recorded("col:lt-right") === 460, "采帧这一刻就把右栏位置记下了（460），不是留到收尾去读尸体");
  ok(
    vm.runInContext('LT_SCROLL_SUB["ta:/n_a1:goal"] ? LT_SCROLL_SUB["ta:/n_a1:goal"].top : null', sb) === 130,
    "栏内多行框的位置同样在采帧时落表（130）",
  );

  /* 真实重建：旧栏被摘出文档 → 浏览器把它与后代一起归零；新栏是干净的 */
  right.scrollTop = 0;
  ta.scrollTop = 0;
  const right2 = scroller("lt-right", 300, 1200, 0);
  const ta2 = scroller("lt-in", 66, 400, 0);
  ta2.setAttribute("data-lt-hk", "/n_a1:goal");
  right2.appendChild(ta2);
  ui.right = right2;
  ui.head = scroller("lt-head", 30, 900, 0);
  rebind(s);

  ok(recorded("col:lt-right") === 460, "旧栏归零后，表里那条记录没被抹掉（仍记着 460）");
  ok(right2.scrollTop === 460, "新右栏照旧停在 460 —— 不再被顶回顶上（本次需求修的就是这一格）");
  ok(ta2.scrollTop === 130, "栏内多行框的滚动条同样贴回 130");
  ok(
    /snap\.saved/.test(fnSrc(LTU, "ltScrollApply")) && fnSrc(LTU, "ltScrollSnapshot").indexOf("ltScrollApply(snap)") > 0,
    "口径落在源码上：采帧即落表（ltScrollSnapshot 里就调 ltScrollApply），收尾不再回读旧元素",
  );

  /* 对照：用户真的自己滚回顶上 → 照旧不记（新内容长高后不许把它钉在半空） */
  const sb2 = sandboxFor(SCROLL_FNS);
  const r = scroller("lt-right", 300, 1600, 0);
  sb2.LT_UI = { right: r, head: null, left: null };
  vm.runInContext("ltScrollSnapshot()", sb2);
  ok(
    vm.runInContext('LT_SCROLL["col:lt-right"] ? LT_SCROLL["col:lt-right"].top : null', sb2) === null,
    "明明滚在顶上 = 用户自己滚回去了 → 不记（与旧口径一致）",
  );
}

console.log("\n[6] 与既有保护的关系（口径不重复也不互相打架）");
{
  ok(fnSrc(LTU, "ltRenderMain").indexOf("ltDeferBecauseHold()") > 0, "ltRenderMain 也吃这条（按栏保留 / 整块重建两条路都在它之后）");
  ok(/按住保护（本次需求）/.test(LTU) && /滚动位置保护（本需求）/.test(LTU), "源码里写清了这两条保护的来处与症状（下一次不会再被当成「重绘顺手删掉」的代码）");
  ok(fnSrc(LTU, "ltColHoldNow").indexOf("ltStripHoldNow()") > 0, "被推迟的重绘也等按住态放开（不会在松手之前把鼠标底下那一件换掉）");
  ok(/LT_SCROLL/.test(CSS) && /ltScrollSnapshot/.test(CSS), "样式里也说清了滚动位置的真源（.lt-right 那一行注释指向 app-longtask-ui.js 的 LT_SCROLL，不走浏览器那套不可控的滚动锚定）");
  ok(/不掺浏览器那套按内容锚定的启发式|不走浏览器那套不可控的滚动锚定/.test(CSS), "并且明说了「位置只由 LT_SCROLL 那一处说了算」（免得两边各拉一半、滚动条来回跳）");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-strip-scroll)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-strip-scroll)",
);
process.exit(fails ? 1 : 0);