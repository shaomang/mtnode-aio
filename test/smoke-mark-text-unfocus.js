"use strict";
/* 绘制文字（.mk-text）失焦回归 —— 纯 Node，只读源码文本 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-mark-text-unfocus.js
 * 规则要保住的行为：画布上「文本」绘制（.mk-text，contentEditable）编辑中，
 * **点画布任何其它位置都必须退出编辑态**（失焦 + 兑现被推迟的重绘 + 文本落盘）。
 * 为什么以前退不出：画布空白 / 节点 / 组 / 端子 / 各类拖拽手柄的 mousedown 普遍
 * preventDefault（各自为了阻止原生拖选 / 保住拖拽），preventDefault 会连「焦点转移」
 * 一起挡掉 —— contentEditable 一直握着 document.activeElement；而 renderCanvas 在
 * isMarkTextEditing() 为真时把重绘 defer 掉，于是点哪儿都退不出编辑态、被推迟的重绘
 * 也永远补不上。所以必须（且只能在）document 捕获阶段显式补一次 blur。
 * 覆盖：
 *   [1] 判据函数 markTextBlurOnOutsidePointer 存在，bindCanvas 在 document 捕获阶段挂上它
 *   [2] 豁免口径：点在正在编辑的那枚绘制自身内部（移动 / 缩放手柄、工具条、颜色选择器）不收
 *   [3] 真跑：vm 里喂 4 种 mousedown 目标，验证谁 blur 谁不 blur
 *   [4] 为什么必须显式 blur：空白 mousedown 仍 preventDefault + renderCanvas 的 defer 机制
 *   [5] blur 之后正文落盘、被 defer 的重绘被兑现（flushDeferredMarkCanvas）
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
/* 源码统一按 \n 处理（仓库是 CRLF），切段与断言不必管行尾差异 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const app = read("renderer/app.js");
const canvasJs = read("renderer/app-canvas.js");

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
/* bindCanvas 函数体（本缺陷的接线处） */
const bindBody = fnBody(app, "bindCanvas");

console.log("\n[1] 判据就位 + 挂在 document 捕获阶段");
{
  ok(
    fnBody(app, "markTextBlurOnOutsidePointer").indexOf("ae.blur()") > 0,
    "app.js 有 markTextBlurOnOutsidePointer（编辑态下显式 blur 的判据）",
  );
  ok(
    bindBody.indexOf(
      'document.addEventListener("mousedown", markTextBlurOnOutsidePointer, true);',
    ) > 0,
    "bindCanvas 把判据挂在 document 的 mousedown 捕获阶段（早于各处 preventDefault 生效）",
  );
  /* 捕获阶段的必需性：绑在 #canvas 上就不够 —— 节点 / 手柄自己的 mousedown 会先跑 */
  ok(
    bindBody.indexOf('canvas.addEventListener(\n    "mousedown"') > 0,
    "画布自身那条 mousedown 监听仍在（本判据是加在它之前的document 级补充）",
  );
  const helper = fnBody(app, "markTextBlurOnOutsidePointer");
  ok(
    helper.indexOf('"mk-text"') > 0 && helper.indexOf("isContentEditable") > 0,
    "判据只看「绘制文字」这一种编辑态：isContentEditable + class mk-text（别处输入框不掺和）",
  );
}

console.log("\n[2] 豁免口径：点在正在编辑的那枚绘制自身内部不收起");
{
  const helper = fnBody(app, "markTextBlurOnOutsidePointer");
  ok(
    helper.indexOf('ae.closest(".wf-mark")') > 0 && helper.indexOf("owner.contains(t)") > 0,
    "点在正在编辑的那枚绘制（.wf-mark）内部 → 放行：移动 / 缩放手柄、工具条、颜色选择器照旧可用",
  );
}

console.log("\n[3] 真跑：4 种 mousedown 目标");
{
  let blurred = 0;
  const ownerInside = { nodeType: 1, id: "inside" };
  const ownerEl = {
    contains(t) {
      return t === ownerInside;
    },
  };
  const ae = {
    isContentEditable: true,
    classList: { contains: (c) => c === "mk-text" },
    closest: (sel) => (sel === ".wf-mark" ? ownerEl : null),
    blur() {
      blurred++;
    },
  };
  const field = {
    isContentEditable: false,
    classList: { contains: () => false },
    blur() {
      blurred += 100;
    },
  };
  const sb = { console, document: { activeElement: ae } };
  vm.createContext(sb);
  vm.runInContext(fnBody(app, "markTextBlurOnOutsidePointer"), sb);
  const run = (target) => {
    sb.__t = target;
    return vm.runInContext("markTextBlurOnOutsidePointer({ target: __t })", sb);
  };

  blurred = 0;
  ok(
    run({ nodeType: 1, id: "canvas" }) === true && blurred === 1,
    "点在画布空白（canvas 元素）→ 收起编辑态（这正是原来 preventDefault 挡掉失焦的那条路）",
  );
  blurred = 0;
  ok(
    run({ nodeType: 1, id: "node-head" }) === true && blurred === 1,
    "点在节点 / 组 / 手柄（非绘制的元素）→ 同样收起（它们各自 preventDefault，浏览器不会自己移焦点）",
  );
  blurred = 0;
  ok(
    run({ nodeType: 1, id: "other-mk-text" }) === true && blurred === 1,
    "点在另一枚绘制文字上 → 先收起当前这枚（随后浏览器把焦点给新的那枚）",
  );
  blurred = 0;
  ok(
    run(ownerInside) === false && blurred === 0,
    "点在正在编辑的那枚绘制自身内部（工具条 / 手柄）→ 不收，编辑不中断",
  );
  sb.document.activeElement = field;
  blurred = 0;
  ok(
    run({ nodeType: 1, id: "canvas" }) === false && blurred === 0,
    "当前焦点不是 .mk-text（如节点的 textarea）→ 判据什么都不做",
  );
  sb.document.activeElement = null;
  ok(run({ nodeType: 1, id: "canvas" }) === false && blurred === 0, "没有活动元素时不报错、不误动");
}

console.log("\n[4] 为什么必须显式 blur（两条前提都要还在，否则本判据可以删）");
{
  const canvasBind = bindBody;
  const at = canvasBind.indexOf('if (ev.target === canvas || ev.target.id === "stage")');
  ok(at > 0, "画布空白分支仍在 bindCanvas 里（else 之后就该显式失去焦点）");
  const blank = canvasBind.slice(at, canvasBind.indexOf("setCanvasPanning(true);", at));
  ok(
    blank.indexOf("ev.preventDefault();") > 0,
    "画布空白 mousedown 仍 preventDefault（阻止原生拖选）→ 焦点不会自己移走，所以必须显式 blur",
  );
  ok(
    canvasJs.indexOf("function isMarkTextEditing()") > 0 &&
      /if \(isMarkTextEditing\(\)\) \{\s*\n\s*S\._deferCanvasForMarkEdit = true;\s*\n\s*return;/.test(
        canvasJs,
      ),
    "renderCanvas 仍在「正在编辑绘制文字」时把重绘 defer 掉（所以失焦后必须有人兑现它）",
  );
}

console.log("\n[5] 失焦之后：正文落盘 + 兑现被 defer 的重绘");
{
  const blurHandler = canvasJs.slice(
    canvasJs.indexOf('t.addEventListener("blur", () => {'),
    canvasJs.indexOf('t.addEventListener("keydown"'),
  );
  ok(
    blurHandler.indexOf("m.text = (t.innerText || t.textContent || \"\").replace(/\\n$/, \"\")") > 0,
    ".mk-text 的 blur 处理器照旧把正文写回 m.text（不改口径）",
  );
  ok(blurHandler.indexOf("scheduleSave(true)") > 0, "blur 后落盘（scheduleSave(true)）");
  ok(
    blurHandler.indexOf("setTimeout(flushDeferredMarkCanvas, 0)") > 0,
    "blur 后 setTimeout 兑现被 defer 的重绘（终止「点哪儿都退不出编辑态」的循环）",
  );
  ok(
    canvasJs.indexOf("function flushDeferredMarkCanvas()") > 0 &&
      canvasJs.indexOf("if (!S._deferCanvasForMarkEdit) return;") > 0,
    "flushDeferredMarkCanvas 只在真有被推迟的重绘时才重绘（没有就不动 DOM）",
  );
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-mark-text-unfocus)"
    : "\n✓ " + checks + " 项全部通过  (smoke-mark-text-unfocus)",
);
process.exit(fails ? 1 : 0);
