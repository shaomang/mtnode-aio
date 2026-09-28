"use strict";
/* 长任务条带右栏「滚动位置被顶回顶上」的真正根因回归 —— 纯 Node，只读源码文本 + vm 真跑
 *   node test/smoke-longtask-side-null-run.js
 *
 * 缺陷（本次需求）：长任务跑着时右栏（检查器 / 人工任务卡 / 卡住的环节 / 图说明）往下读，
 * 一停手就被顶回顶上，而且**只要任务在跑就反复跳**。前一轮加的 ltScrollSnapshot /
 * ltScrollRebind 滚动保护本身没问题 —— 问题在于它**根本跑不到**：
 *
 *   app-longtask-ui.js 的 ltRenderSide 里那句
 *       const stuck = run && Object.keys(run.nodes || {}).filter(...);
 *   `run && …` 在 run 为空时求值成 **null**（不是 false、不是 []），紧接着的
 *   `if (stuck.length)` 当场抛 TypeError。异常从 ltRenderSide → ltRenderMain →
 *   ltRenderStrip 一路冒出去，而 ltRenderStrip 的三步重建与收尾是顺序写的：
 *       ltRenderHead(wf) → ltRenderMain(wf) → ltScrollRebind(scrollSnap)
 *   前两步已经把右栏 innerHTML 清空，第三步因此永远执行不到 ——
 *   新右栏 scrollTop = 0、旧栏的滚动位置也没被贴回，于是「每约 90ms 一次的重绘都把
 *   用户正在读的那一栏顶回顶上」。触发面很常见：任务存着 activeRun、但内存里那份 run
 *   还没认领（冷启动 / 「任务已删除」回收过 LT_RUNS），ltCurrentRun(wf) 就是 null。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 源码闸：stuck 必须落成数组（run 为空时是 []），不许再出现 `const stuck = run && …`
 *   [2] vm 真跑：run = null 时 ltRenderSide 不抛异常，右栏照样长出「卡住的环节」以外的内容
 *   [3] vm 真跑：完整走一遍「采帧 → 重建右栏 → 贴回」，滚动位置必须原样保住（本次需求的症状）
 *   [4] 反证：把 ltRenderSide 换成一个必抛的替身，ltScrollRebind 就再也贴不回 —— 说明
 *       「渲染步骤抛异常 = 滚动位置归零」正是本次症状的机理（不是滚动保护自己坏）
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
/* 源码闸要看**代码**、不看注释：本次修复的注释里就原样引用了那句坏写法
   （解释来处用），拿全文做正则必然误判。这里只把块注释与行注释抹成等长空白，
   行号与缩进保持原样，代码断言才有意义。 */
const LTU_CODE = LTU.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(
  /(^|[^:"'`\\])\/\/[^\n]*/g,
  (m, p1) => p1 + " ".repeat(m.length - p1.length),
);

/* 函数体（含首尾大括号）：与 smoke-longtask-strip-scroll.js 同一口径 */
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

/* ── 迷你 DOM（classList / children / 滚动几何 / querySelectorAll）── */
function mkEl(tag, cls) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    className: cls || "",
    children: [],
    parentNode: null,
    attrs: {},
    textContent: "",
    title: "",
    style: {},
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    hidden: false,
    addEventListener() {},
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
    closest() {
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
  };
  el.classList = {
    contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0,
    add: (c) => {
      if (!el.classList.contains(c)) el.className = (el.className + " " + c).trim();
    },
    remove: (c) => {
      el.className = String(el.className)
        .split(/\s+/)
        .filter((x) => x && x !== c)
        .join(" ");
    },
    toggle() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set() {
      for (const c of this.children.slice()) this.removeChild(c);
    },
  });
  Object.defineProperty(el, "isConnected", {
    get() {
      let p = this;
      let hops = 0;
      while (p) {
        if (p.parentNode == null) return hops > 0;
        p = p.parentNode;
        hops++;
      }
      return false;
    },
  });
  return el;
}
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
];
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
      ltEl: (tag, cls, txt) => {
        const e = mkEl(tag, cls);
        if (txt != null) e.textContent = String(txt);
        return e;
      },
      ltT: (s) => String(s),
      ltArr: (v) => (Array.isArray(v) ? v : []),
      ltStr: (v) => String(v == null ? "" : v),
    },
    extra || {},
  );
  vm.createContext(sb);
  for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
  return sb;
}

console.log("\n[1] 源码闸：stuck 必须落成数组，不许再是 run && … 的短路值");
{
  ok(
    !/const stuck =\s*\n?\s*run\s*&&/.test(LTU_CODE),
    "ltRenderSide 里不再有 `const stuck = run && Object.keys(...).filter(...)`（run 为空时它等于 null）",
  );
  ok(
    /const hasRun = !!run;/.test(LTU_CODE) && /const stuck = hasRun/.test(LTU_CODE),
    "先给 run 归一成一个明确的布尔（hasRun），stuck 按它分支",
  );
  ok(
    /: ltArr\(null\);/.test(LTU_CODE),
    "run 为空时 stuck 走 ltArr(null) → []（数组口径与其它清单一致，.length 永远安全）",
  );
  ok(
    /if \(stuck\.length\) \{/.test(LTU_CODE) && /ltArr\(null\);\n\s*if \(stuck\.length\)/.test(LTU_CODE),
    "紧接着的 `if (stuck.length)` 现在读的一定是数组",
  );
  ok(
    /run 为空（任务存着 activeRun/.test(LTU),
    "源码里写清了来处与症状（下一次不会再被当成「重绘顺手删掉」的代码）",
  );
}

console.log("\n[2] vm 真跑：run = null 时 ltRenderSide 不抛异常，右栏照样长内容");
{
  const right = scroller("lt-right", 300, 900, 380);
  const made = [];
  const sb = sandboxFor(["ltRenderSide"], {
    LT_UI: { right },
    ltSel: { path: "", edge: "" },
    ltHumanCard: () => {
      const c = mkEl("div", "lt-card");
      made.push("human");
      return c;
    },
    ltBlockedCard: () => {
      made.push("blocked");
      return mkEl("div", "lt-card");
    },
    ltEdgeInspector: () => made.push("edge"),
    ltNodeInspector: () => made.push("node"),
    ltOverviewInspector: (host) => {
      made.push("overview");
      host.appendChild(mkEl("div", "lt-ov"));
    },
  });
  const side = vm.runInContext("ltRenderSide", sb);
  let err = null;
  try {
    /* run = null 正是「任务存着 activeRun、内存里那份 run 还没认领」那一刻 */
    side(right, { id: "wf" }, { uid: "t1", name: "任务" }, null);
  } catch (e) {
    err = e;
  }
  ok(!err, "ltRenderSide(right, wf, task, null) 不抛异常（得到 " + (err ? err.message : "无异常") + "）");
  ok(made.indexOf("overview") >= 0 || made.indexOf("node") >= 0, "右栏照常渲染检查器 / 图说明（没有因为 run 空就整块空掉）");
  ok(right.children.length >= 1, "右栏真的挂上了内容（children=" + right.children.length + "）");
  ok(made.indexOf("blocked") < 0, "run 为空 → 不列「卡住的环节」卡（没有清单可列）");
}

console.log("\n[3] vm 真跑：漫游一整遍「采帧 → 重建右栏 → 贴回」，滚动位置必须原样保住");
{
  const oldRight = scroller("lt-right", 300, 1400, 520);
  const head = scroller("lt-head", 40, 40, 0);
  const left = scroller("lt-left", 300, 300, 0);
  const ui = { right: oldRight, left, head };
  const sb = sandboxFor(SCROLL_FNS, {
    LT_UI: ui,
    ltHoverHere: () => {},
    ltColOf: (root, cls) => {
      for (const c of root.children) if (c.classList.contains(cls)) return c;
      return null;
    },
  });
  const snapshot = vm.runInContext("ltScrollSnapshot", sb);
  const rebind = vm.runInContext("ltScrollRebind", sb);
  const snap = snapshot();
  ok(!!snap && snap.parts.some((p) => p.key === "col:lt-right"), "采帧带上了右栏（key=col:lt-right）");
  /* 重建：造一只同构的新右栏换进 LT_UI（模拟 ltRenderMain 的整块重建），
     新元素 scrollTop 天然是 0 —— 滚动保护没跑起来的话，用户看到的就是「回到顶端」 */
  const fresh = scroller("lt-right", 300, 1400, 0);
  ui.right = fresh;
  rebind(snap);
  ok(fresh.scrollTop === 520, "重建后右栏仍在 520（得到 " + fresh.scrollTop + "）");
  ok(oldRight.scrollTop === 520, "老栏的位置没被抹掉（ltScrollApply 记的是事实，不是 0）");
}

console.log("\n[4] 反证：渲染步骤抛异常 → 贴回再也跑不到（本次症状的机理）");
{
  const oldRight = scroller("lt-right", 300, 1400, 430);
  const ui = { right: oldRight, left: scroller("lt-left", 300, 300, 0), head: scroller("lt-head", 40, 40, 0) };
  const sb = sandboxFor(SCROLL_FNS, { LT_UI: ui, ltHoverHere: () => {} });
  const snapshot = vm.runInContext("ltScrollSnapshot", sb);
  const rebind = vm.runInContext("ltScrollRebind", sb);
  const snap = snapshot();
  /* ltRenderStrip 的真实形状：先重建（旧栏被换掉），再收尾贴回 */
  const boom = () => {
    throw new TypeError("Cannot read properties of null (reading 'length')");
  };
  const fresh = scroller("lt-right", 300, 1400, 0);
  let caught = null;
  try {
    boom(); /* ← ltRenderMain 里的 ltRenderSide 抛了 */
    ui.right = fresh;
    rebind(snap); /* ← 收尾这一步因此永远执行不到 */
  } catch (e) {
    caught = e;
  }
  ok(!!caught, "渲染抛出的异常会冒到 ltRenderStrip（它没有兜底），收尾那一步被跳过");
  ok(fresh.scrollTop === 0, "于是新右栏停在 0 = 用户看到的「回到顶端」");
  /* 反过来：异常不再发生（本次修复）→ 收尾照常贴回 */
  ui.right = scroller("lt-right", 300, 1400, 0);
  rebind(snap);
  ok(ui.right.scrollTop === 430, "异常消失后，同一条收尾把位置贴回 430（修复后的行为）");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-side-null-run)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-side-null-run)",
);
process.exit(fails ? 1 : 0);