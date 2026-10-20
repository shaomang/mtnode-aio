"use strict";
/* 展开节点层里的滚轮归属（节点内容自己滚，不缩放镜头）—— 纯 Node，不依赖 Electron
 *   node test/smoke-canvas-wheel-scroll.js
 *
 * 背景（本轮修的 bug）：画布 wheel 处理器里，只有「展开节点层内部舞台」（.super-stage）
 * 被放行去缩放镜头，其它 .wf-node 一律 return（交回原生滚动）。于是在展开的节点层 / 全屏进入态
 * 的壳里，指针压在文本节点的板身正文框（textarea.n-text）上滚轮时，滚的是整张画布 ——
 * 长正文根本滚不动。用户口径（已确认）：
 *   · 所有可滚动的节点内容区（textarea / 输出面板 / 节点内会话 / 代码块 / 文件视图）都归内容；
 *   · 内容滚到顶 / 到底继续滚 → 停住，不缩放；
 *   · Ctrl / ⌘ + 滚轮仍归画布缩放；
 *   · 内容装得下（滚不动）→ 照常缩放画布；
 *   · 全屏 focus 子画布与就地展开壳都要生效。
 *
 * 覆盖：
 *   [1] 真跑 canvasWheelContentOwner / elHasOverflowScroll：各类容器认领与否
 *   [2] 两轴（竖向 / Shift 横向）各认各的
 *   [3] 认领范围只到 .wf-node 为止（节点外面的滚动容器不算）
 *   [4] 源码口径：判定排在 .super-stage 分支之前、不放 preventDefault、修饰键放行
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
    .replace(/\r\n?/g, "\n");

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
function fnBody(src, name) {
  const p = new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m");
  const m = src.match(p);
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p2 = src[j - 1];
    if (inStr) {
      if (c === inStr && p2 !== "\\") inStr = null;
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
  throw new Error("函数体没闭合：" + name);
}

const appSrc = read("renderer/app.js");

/* ---------- 迷你 DOM：只需要 closest / parentElement / 尺寸 / overflow ---------- */
function fakeEl(opt) {
  opt = opt || {};
  const el = {
    nodeType: 1,
    tagName: opt.tag || "DIV",
    isContentEditable: !!opt.ce,
    parentElement: opt.parent || null,
    scrollHeight: opt.sh == null ? 0 : opt.sh,
    clientHeight: opt.ch == null ? 0 : opt.ch,
    scrollWidth: opt.sw == null ? 0 : opt.sw,
    clientWidth: opt.cw == null ? 0 : opt.cw,
    _classes: String(opt.cls || "").split(" ").filter(Boolean),
    _ovX: opt.ovX || "visible",
    _ovY: opt.ovY || "visible",
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === ".wf-node" && cur._classes.indexOf("wf-node") >= 0) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
  };
  return el;
}

const sandbox = {
  window: {
    getComputedStyle(el) {
      return { overflowX: el._ovX, overflowY: el._ovY };
    },
  },
};
vm.createContext(sandbox);
for (const name of ["canvasWheelAxis", "elHasOverflowScroll", "canvasWheelContentOwner"]) {
  vm.runInContext(fnBody(appSrc, name), sandbox, { filename: "renderer/app.js#" + name });
}
const owner = (target, ev) =>
  sandbox.canvasWheelContentOwner(Object.assign({ target }, ev || { deltaY: 100 }));

console.log("[1] 可滚动内容区认领滚轮");
{
  const node = fakeEl({ cls: "wf-node in" });
  const body = fakeEl({ cls: "n-body", parent: node, ovY: "hidden" });
  /* 长正文的 textarea：内容 800 > 可视 200 */
  const ta = fakeEl({
    tag: "TEXTAREA",
    cls: "n-text",
    parent: body,
    sh: 800,
    ch: 200,
    ovY: "auto",
  });
  ok(owner(ta) === ta, "文本节点 textarea 内容超出 → 归 textarea 滚（正是本轮 bug 现场）");
  ok(owner(body) === null, "节点 body（overflow:hidden 且装得下）→ 不认领");

  const taShort = fakeEl({
    tag: "TEXTAREA",
    cls: "n-text",
    parent: body,
    sh: 180,
    ch: 200,
    ovY: "auto",
  });
  ok(owner(taShort) === null, "短正文（内容装得下）→ 不认领，照常缩放画布");

  const taBottom = fakeEl({
    tag: "TEXTAREA",
    cls: "n-text",
    parent: body,
    sh: 800,
    ch: 200,
    ovY: "auto",
  });
  ok(owner(taBottom) === taBottom, "滚到最底仍认领 → 继续滚停住，不缩放（边界口径）");

  /* 输出面板：普通 div，overflow:auto + 内容超出 */
  const out = fakeEl({
    cls: "n-out",
    parent: body,
    sh: 900,
    ch: 300,
    ovY: "auto",
  });
  ok(owner(out) === out, "输出面板 .n-out（overflow:auto 且超出）→ 认领");

  /* 只有 overflow:auto、内容装得下 → 不认领 */
  const outShort = fakeEl({ cls: "n-out", parent: body, sh: 200, ch: 300, ovY: "auto" });
  ok(owner(outShort) === null, "overflow:auto 但内容装得下 → 不认领");

  /* overflow:visible 的元素即使尺寸超出也不认领（沿用 browseWheelNativeOwner 口径） */
  const flat = fakeEl({ cls: "n-view", parent: body, sh: 900, ch: 300, ovY: "visible" });
  ok(owner(flat) === null, "overflow:visible → 不认领");

  /* contenteditable 富文本编辑面：不看 computed overflow，只要有超出就认领 */
  const ce = fakeEl({ cls: "js-edit", parent: body, sh: 900, ch: 300, ce: true, ovY: "visible" });
  ok(owner(ce) === ce, "contenteditable 编辑面（内容超出）→ 认领");

  /* 内层不是滚动区、外层才是：从目标往上找得到 */
  const outer = fakeEl({ cls: "agent-conv", parent: body, sh: 1200, ch: 400, ovY: "auto" });
  const inner = fakeEl({ cls: "dsh-msg", parent: outer, sh: 40, ch: 40, ovY: "visible" });
  ok(owner(inner) === outer, "指针压在内层子元素上 → 认领最近的可滚祖先（节点内会话）");
}

console.log("[2] 两轴各认各的");
{
  const node = fakeEl({ cls: "wf-node proc" });
  const body = fakeEl({ cls: "n-body", parent: node, ovY: "hidden" });
  const pre = fakeEl({
    tag: "PRE",
    cls: "dsh-code",
    parent: body,
    sw: 1600,
    cw: 400,
    sh: 100,
    ch: 100,
    ovX: "auto",
    ovY: "visible",
  });
  ok(
    owner(pre, { deltaX: 60, deltaY: 0 }) === pre,
    "Shift+滚轮 / 触控板横滑（deltaX）→ 横滚容器认领",
  );
  ok(owner(pre, { deltaY: 60 }) === null, "竖向滚轮落在横向容器上 → 不认领（照常缩放）");
  ok(owner(pre, { deltaX: 0, deltaY: 0 }) === null, "零 delta → 不认领");
}

console.log("[3] 认领范围只到 .wf-node 为止");
{
  const stage = fakeEl({ cls: "super-stage", sh: 5000, ch: 500, ovY: "auto" });
  const node = fakeEl({ cls: "wf-node task", parent: stage });
  const body = fakeEl({ cls: "n-body", parent: node, ovY: "hidden" });
  const label = fakeEl({ cls: "n-status", parent: body, sh: 20, ch: 20 });
  ok(owner(label) === null, "节点外层的滚动容器（展开壳 stage）不被当成内容区");
  ok(owner(stage) === null, "指针直接在 stage 上 → 不认领（壳内空白处照旧缩放）");
}

console.log("[4] 源码口径：判定位置与修饰键");
{
  const at = appSrc.indexOf('canvas.addEventListener(\n    "wheel"');
  ok(at > 0, "找到画布 wheel 处理器");
  const handler = appSrc.slice(at, appSrc.indexOf("rememberLevelView(S.wf);", at));
  const ownerAt = handler.indexOf("canvasWheelContentOwner(ev)");
  /* 认真正的判定分支（注释里也会提到 .super-stage，按代码口径找） */
  const stageAt = handler.indexOf('!ev.target.closest(".super-stage")');
  ok(ownerAt > 0, "处理器调用了 canvasWheelContentOwner");
  ok(
    ownerAt > 0 && stageAt > ownerAt,
    "内容区判定排在「展开节点层缩放例外」之前（否则仍会先缩放）",
  );
  ok(
    /!ev\.ctrlKey\s*&&\s*!ev\.metaKey\s*&&\s*canvasWheelContentOwner\(ev\)/.test(handler),
    "Ctrl / ⌘ + 滚轮放行给画布缩放",
  );
  const ownerLine = handler.slice(handler.lastIndexOf("\n", ownerAt) + 1, handler.indexOf("\n", ownerAt));
  ok(/return;\s*$/.test(ownerLine || ""), "认领即 return（交给原生滚动）");
  ok(
    !/preventDefault/.test(ownerLine || ""),
    "认领那一支不 preventDefault（否则文本框反而滚不动）",
  );
  ok(!/\belse\b/.test(ownerLine || ""), "认领是独立早退，不受下面 stage 分支影响");
  ok(
    /function elHasOverflowScroll/.test(appSrc) &&
      /scrollHeight > el\.clientHeight \+ 1/.test(appSrc),
    "滚动判定按实际尺寸（不能用「有 overflow:auto」冒充能滚）",
  );
}

console.log("\n结果：" + checks + " 项，失败 " + fails + " 项");
if (fails) process.exitCode = 1;
