"use strict";
/* 无端子一侧不画接线排分割线 —— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-node-port-divider.js
 *
 * 本轮需求：所有画布节点，当某一侧不存在输入 / 输出端子时，就不显示那侧的
 * 「接线排」竖直分割线（.wf-node::before / ::after 那道凹陷刻线，本是为放置端子接口而渲染）。
 * 覆盖：
 *   [1] syncPortSideClasses：0 入 → .no-in-ports · 0 出 → .no-out-ports（逐侧判定，真跑函数）
 *   [2] 端子数变化（连 / 断线、增量端子）后同一份口径复算，不残留旧类
 *   [3] 展开的超级节点（板内是子画布）不插手外侧两排
 *   [4] 接线：nodeElement / refreshPorts 都盖章；canvas.css 只关阴影、不动背景与尺寸
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const CANVAS = read("renderer/app-canvas.js");
const CSS = read("renderer/css/canvas.css");

/* ============================ 迷你 DOM ============================ */
function mkEl(cls) {
  const el = { _cls: String(cls || "") };
  Object.defineProperty(el, "className", {
    get: () => el._cls,
    set: (v) => {
      el._cls = String(v);
    },
  });
  el.classList = {
    contains: (c) => el._cls.split(/\s+/).indexOf(c) >= 0,
    add: (c) => {
      if (!el.classList.contains(c)) el._cls = (el._cls + " " + c).trim();
    },
    remove: (c) => {
      el._cls = el._cls
        .split(/\s+/)
        .filter((x) => x && x !== c)
        .join(" ");
    },
    toggle: (c, on) => {
      const has = el.classList.contains(c);
      const want = on === undefined ? !has : !!on;
      if (want && !has) el.classList.add(c);
      else if (!want && has) el.classList.remove(c);
      return want;
    },
  };
  return el;
}

/* ============ 从 app-canvas.js 抠出 syncPortSideClasses 真身 ============ */
function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("找不到 " + sig);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(sig + " 括号不闭合");
}
const SYNC_SRC = sliceFn(CANVAS, "function syncPortSideClasses(el, node) {");

/* ============================ 沙箱 ============================ */
const counts = { in: 0, out: 0, open: false };
const sandbox = {
  superIsOpenShell: () => counts.open,
  inputCount: () => counts.in,
  outputCount: () => counts.out,
};
vm.createContext(sandbox);
vm.runInContext(SYNC_SRC + "\nvar syncPortSideClasses = syncPortSideClasses;", sandbox, {
  filename: "app-canvas.js#syncPortSideClasses",
});
const sync = (el, node) => sandbox.syncPortSideClasses(el, node);
const set = (i, o, open) => {
  counts.in = i;
  counts.out = o;
  counts.open = !!open;
};

/* ==================== [1] 逐侧判定 ==================== */
console.log("\n[1] 该侧没有端子 → 只关那侧的分割线");
let el = mkEl("wf-node proc");
set(0, 0, false);
sync(el, { id: "n1", kind: "execute" });
ok(el.classList.contains("no-in-ports"), "0 入 → .no-in-ports（左侧分割线关掉）");
ok(el.classList.contains("no-out-ports"), "0 出 → .no-out-ports（右侧分割线关掉）");

el = mkEl("wf-node proc");
set(0, 1, false);
sync(el, { id: "n2", kind: "input_text" });
ok(el.classList.contains("no-in-ports"), "只 0 入（如文本输入节点）→ 关左侧");
ok(!el.classList.contains("no-out-ports"), "有输出 → 右侧分割线保留");

el = mkEl("wf-node proc");
set(3, 0, false);
sync(el, { id: "n3", kind: "net_send" });
ok(!el.classList.contains("no-in-ports"), "有输入 → 左侧分割线保留");
ok(el.classList.contains("no-out-ports"), "只 0 出（如发送节点）→ 关右侧");

el = mkEl("wf-node proc");
set(1, 1, false);
sync(el, { id: "n4", kind: "proc_text" });
ok(
  !el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"),
  "两侧都有端子 → 一道分割线都不减",
);

/* ==================== [2] 端子数变化后复算 ==================== */
console.log("\n[2] 端子数变化（连 / 断线、增量端子）后复算，不残留旧类");
el = mkEl("wf-node proc");
set(0, 0, false);
sync(el, { id: "n5" });
ok(el.classList.contains("no-in-ports"), "起点：两侧都关");
set(1, 1, false);
sync(el, { id: "n5" });
ok(!el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"), "连上端子 → 两类都撤掉（分割线回来）");
set(2, 0, false);
sync(el, { id: "n5" });
ok(!el.classList.contains("no-in-ports") && el.classList.contains("no-out-ports"), "输出端清零 → 只补回右侧的关闭态");
/* 重复盖章幂等：类不能越盖越多 */
sync(el, { id: "n5" });
ok(el.className.split(/\s+/).filter((c) => c === "no-out-ports").length === 1, "重复盖章幂等（类不重复）");
ok(sync(mkEl("x"), null) === undefined && sync(null, {}) === undefined, "无元素 / 无节点时空跑不抛错");

/* ==================== [3] 展开的超级节点不插手 ==================== */
console.log("\n[3] 展开的超级节点（板内是子画布）外侧两排仍交给 .super-open");
el = mkEl("wf-node super super-open");
set(0, 0, true);
sync(el, { id: "s1", kind: "super", superOpen: true });
ok(
  !el.classList.contains("no-in-ports") && !el.classList.contains("no-out-ports"),
  "展开壳不加这两类（外侧两排由 .super-open 关，内侧端子恒 ≥1）",
);

/* ==================== [4] 接线检查 ==================== */
console.log("\n[4] 接线：建元素 / 刷端子两处盖章，CSS 只关阴影");
ok(CANVAS.indexOf(SYNC_SRC) >= 0, "app-canvas.js：syncPortSideClasses 真身在（不是只在测试里）");
const refreshSrc = sliceFn(CANVAS, "function refreshPorts(el, node) {");
ok(refreshSrc.indexOf("syncPortSideClasses(el, node)") >= 0, "refreshPorts：端子位置与侧面类同一处刷新");
const nodeSrc = sliceFn(CANVAS, "function nodeElement(node) {");
ok(nodeSrc.indexOf("syncPortSideClasses(el, node)") >= 0, "nodeElement：建元素时就按当前端子数盖章");
const openAt = nodeSrc.indexOf("if (!superIsOpenShell(node)) {");
const syncAt = nodeSrc.indexOf("syncPortSideClasses(el, node)");
ok(openAt >= 0 && syncAt > openAt, "盖章在 !superIsOpenShell 分支内（展开壳不参与）");
ok(CSS.indexOf(".wf-node.no-in-ports::before") >= 0, "canvas.css：左侧 = ::before");
ok(CSS.indexOf(".wf-node.no-out-ports::after") >= 0, "canvas.css：右侧 = ::after");
const ruleAt = CSS.indexOf(".wf-node.no-in-ports::before");
const rule = CSS.slice(ruleAt, CSS.indexOf("}", ruleAt));
ok(/box-shadow:\s*none/.test(rule), "关闭的只是 box-shadow（那道刻线本身）");
ok(!/display:\s*none/.test(rule) && !/background/.test(rule), "不动 background / 尺寸：接线排条位仍保留（渐变锚定不错位）");
ok(
  CSS.indexOf("inset -1px 0 0 rgba(0, 0, 0, .55)") >= 0 && CSS.indexOf("inset 1px 0 0 rgba(0, 0, 0, .55)") >= 0,
  "有端子时的两排凹陷刻线仍在（只对无端子侧关）",
);

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " checks"));
process.exit(fails ? 1 : 0);