"use strict";
/* 长任务多行框（目标 / 说明）拖高回弹回归 —— 纯 Node，只读源码文本 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-longtask-textarea-height.js
 *
 * 缺陷：条带右栏「目标 / 说明」这类 textarea 用右下角原生手柄拖高，一松手（或长任务一跑）
 * 高度又缩回原样 —— 「拖高自动回弹」。
 * 起因不是 CSS：.lt-in 一直是 resize: vertical，高度由浏览器写在元素的 inline style 上；
 * 而右栏在运行期会被 ltRenderStrip() 整块重建（Agent 每段流式正文都叫一次 ltRenderStripSoon，
 * app-longtask.js 的 onEvent → 90ms 节流）。焦点 / 框选 / 按住三条保护只管「这一帧不重建」，
 * 用户一点别处就放行重建 —— 新长出来的 textarea 没有那段 inline 高度，自然回到默认高。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 机制就位：LT_TA_H 高度表 + ltTaH / ltTaHNow / ltTaHSet / ltTaHApply / ltTaHBind
 *   [2] key 口径与草稿表同源：按「环节 path + 字段名」记，同一个格永远命中同一条记录
 *   [3] 只有「右下角 = 原生缩放手柄」上按下才记账；框内点按 / 框选不打扰原生行为
 *   [4] 真跑：量到的身高记进表，重建后的新框按 key 还原那段 inline 高度（拖高不再回弹）
 *   [5] 量不到尺寸的迷你环境（老运行时 / 检测沙箱）不报错、不写脏值
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
/* 迷你 DOM：够这只回归用（style / 事件 / 尺寸量测 / setPointerCapture） */
function mkEl(tag, cls) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "textarea").toUpperCase(),
    className: cls || "",
    value: "",
    style: {},
    children: [],
    parentNode: null,
    dataset: {},
    attrs: {},
    handlers: {},
    rect: { width: 300, height: 0, right: 400, bottom: 0, top: 0, left: 100 },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    removeEventListener() {},
    getAttribute(k) {
      return this.attrs[k] == null ? null : this.attrs[k];
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getBoundingClientRect() {
      return Object.assign({}, this.rect);
    },
    setPointerCapture() {},
    appendChild(c) {
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    },
    emit(type, ev) {
      for (const fn of (this.handlers[type] || []).slice()) fn(ev || {});
    },
  };
  return el;
}
function sandboxFor(names, extra) {
  const mapExpr = (LTU.match(/const LT_TA_H = ([^;]+);/) || [])[1] || "null";
  const sb = Object.assign(
    { console, Array, Object, String, Number, Date, Math, JSON, isFinite, parseFloat, parseInt },
    { LT_TA_H: vm.runInNewContext(mapExpr, {}) },
    extra || {},
  );
  vm.createContext(sb);
  for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
  return sb;
}
/* 把「量到的身高」摆到这只迷你框上（getBoundingClientRect 只读 rect） */
function setH(el, h) {
  el.rect.height = h;
  el.rect.bottom = el.rect.top + h;
}

console.log("\n[1] 机制就位（renderer/app-longtask-ui.js）");
{
  ok(/const LT_TA_H = Object\.create\(null\);/.test(LTU), "有一张「手动拖高」高度表 LT_TA_H");
  for (const n of ["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"])
    ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
  ok(
    fnBody(LTU, "ltInput").indexOf("ltTaHApply(i, hkey)") > 0 &&
      fnBody(LTU, "ltInput").indexOf("ltTaHBind(i, hkey)") > 0,
    "ltInput 建多行框时先按 key 还原高度、再接上拖高捕获（type = \"area\" 才走）",
  );
  const insp = fnBody(LTU, "ltNodeInspector");
  ok(
    insp.indexOf('ltT("目标 / 说明")') > 0 && insp.indexOf('"area", null, ltDraftKey(path, "goal")') > 0,
    "环节检查器的「目标 / 说明」把 hkey 传给了 ltInput（key = 环节 path + 字段名，第 7 参）",
  );
  ok(
    fnBody(LTU, "ltHumanCard").indexOf("ltTaHBind(why, whyKey)") > 0,
    "审批卡的意见 / 理由框也按同一个草稿键记高度（相当长的多行框，同样不许回弹）",
  );
  ok(
    /textarea\.lt-in\s*\{[^}]*min-height:\s*var\(--lt-ta-h,\s*\d+px\);/.test(CSS),
    "多行框默认高度走 CSS（textarea.lt-in 的 min-height: var(--lt-ta-h, …)）——只设下限，拖高仍是原生行为",
  );
  ok(
    /\.lt-in\s*\{[^}]*resize:\s*vertical;/.test(CSS),
    "resize: vertical 仍在（右下角手柄本来就是给用户拖的，本需求是让拖出来的高度留得住）",
  );
}

console.log("\n[2] key 口径：与草稿表同源（vm 真跑）");
{
  const sb = sandboxFor(["ltTaH"]);
  sb.LT_TA_H["/n_a1:goal"] = 182.4;
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 182, "记下 182px 意味着同一个格读到 182px（四舍五入到整数）");
  ok(vm.runInContext('ltTaH("/n_a1:title")', sb) === 0, "同一个环节的别的字段读不到这一份（不串台）");
  ok(vm.runInContext('ltTaH("")', sb) === 0 && vm.runInContext("ltTaH()", sb) === 0, "空 key / 不传 key → 0（没记过），不报错");
  sb.LT_TA_H["/n_a1:goal"] = -5;
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 0, "脏值（负数）当没记过，不把框压没");
}

console.log("\n[3] 只在右下角（原生缩放手柄）上记账，框内点按不打扰（vm 真跑）");
{
  const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHBind"]);
  const ta = mkEl("textarea", "lt-in");
  ta.rect = { width: 300, height: 66, left: 100, top: 200, right: 400, bottom: 266 };
  setH(ta, 66);
  vm.runInContext("ltTaHBind", sb)(ta, "/n_a1:goal");
  ok(ta.getAttribute("data-lt-hk") === "/n_a1:goal", "key 挂到 data-lt-hk 上（迷你运行 / 事后复核都认得出）");
  /* 框内中部点按（选文字 / 改写）→ 抬起不记账 */
  ta.emit("pointerdown", { clientX: 250, clientY: 230, pointerId: 1 });
  setH(ta, 90);
  ta.emit("pointerup", { clientX: 250, clientY: 230 });
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 0, "框中间按下再抬起（只是点选 / 改写）→ 不记高度，原生交互一字不变");
  /* 右下角按下（= 拖手柄）→ 抬起按当下实际高度记账（第一次抬手后右下角已跟着长高） */
  setH(ta, 90);
  ta.emit("pointerdown", { clientX: 399, clientY: 289, pointerId: 2 });
  setH(ta, 184);
  ta.emit("pointerup", { clientX: 399, clientY: 365 });
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 184, "右下角按下拖高后抬起 → 记下 184px（拖到多高就记多高）");
  /* 键盘 / 无指针路径：失焦也记一次 */
  setH(ta, 120);
  ta.emit("blur", {});
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 120, "不走指针的路径（失焦）也记一次：高度没变也照记，值就是用户当下定的一份");
}

console.log("\n[4] 真跑：记下的高度活过右栏重建（拖高不再回弹）");
{
  const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"]);
  const KEY = "/n_a1:goal";
  vm.runInContext("ltTaHBind", sb)(mkEl("textarea", "lt-in"), KEY);
  /* 第一帧：用户把「目标 / 说明」拖到 208px */
  const first = mkEl("textarea", "lt-in");
  vm.runInContext("ltTaHBind", sb)(first, KEY);
  first.rect.right = 400;
  first.rect.bottom = 266;
  setH(first, 208);
  first.emit("pointerdown", { clientX: 399, clientY: 265, pointerId: 3 });
  first.emit("pointerup", { clientX: 399, clientY: 365 });
  /* 第二帧：右栏被 ltRenderStrip 整块重建 —— 新框是干净的一只（没有 inline 高度） */
  const rebuilt = mkEl("textarea", "lt-in");
  ok(!rebuilt.style.height, "重建出来的新框一开始没有 inline 高度（旧版就是这一步把高度丢了）");
  vm.runInContext("ltTaHApply", sb)(rebuilt, KEY);
  ok(rebuilt.style.height === "208px", "按 key 还原：重建后的框拿回 208px（用户拖出来的那一份）");
  vm.runInContext("ltTaHBind", sb)(rebuilt, KEY); /* 真实路径里 ltInput 还原之后紧跟这一句 */
  /* 别的环节 / 别的字段不会被上一格的高度串到 */
  const other = mkEl("textarea", "lt-in");
  vm.runInContext("ltTaHApply", sb)(other, "/n_a2:goal");
  ok(!other.style.height, "另一个环节的同一格没有记录 → 不贴高度（各记各的）");
  /* 高度表只增不减：与草稿表同一口径，重建不改写已有记录 */
  setH(rebuilt, 240);
  rebuilt.emit("pointerdown", { clientX: 399, clientY: 439, pointerId: 4 });
  rebuilt.emit("pointerup", { clientX: 399, clientY: 439 });
  ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 240, "用户又拖一次 → 覆盖成新的高度（不是追加第二条记录）");
}

console.log("\n[5] 边界：量不到尺寸的迷你环境不报错、不写脏值");
{
  const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"]);
  const noRect = mkEl("textarea", "lt-in");
  noRect.getBoundingClientRect = undefined;
  noRect.offsetHeight = 0;
  ok(vm.runInContext("ltTaHNow", sb)(noRect) === 0 && vm.runInContext("ltTaHNow", sb)(null) === 0, "量不到尺寸（迷你 DOM / 尚未挂载）→ 0，不抛异常");
  ok(vm.runInContext("ltTaHSet", sb)(noRect, "/x:goal") === 0, "量不到就不记账（不会把 0 写成高度把框压没）");
  ok(vm.runInContext('ltTaH("/x:goal")', sb) === 0, "表里确实没写进脏值");
  const plain = { tagName: "TEXTAREA" };
  ok(vm.runInContext("ltTaHApply", sb)(plain, "/x:goal") === plain, "没有 style 的老运行时不报错，原样返回");
  ok(vm.runInContext("ltTaHBind", sb)(null, "/x:goal") === null, "空元素 / 空 key 直接原样返回（调用处不必先判）");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-textarea-height)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-textarea-height)",
);
process.exit(fails ? 1 : 0);