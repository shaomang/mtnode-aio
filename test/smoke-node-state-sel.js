"use strict";
/* 节点「状态灯 / 呼吸灯」× 选中态 回归冒烟测试 —— 纯 Node，只读源码文本（不依赖 Electron）
 *   node test/smoke-node-state-sel.js
 * 规则要保住的行为：节点亮着状态灯（开发节点运行中呼吸灯、任务节点进行中 / 已完成 /
 * 失败 / 阻塞闪烁）时，**选中后状态灯必须仍然存在，并且整体更加高亮**——
 * 既不能被 .sel 规则换成别的颜色「灭掉」，也不能靠 animation:none 把呼吸停掉。
 * 覆盖：
 *   [1] 开发节点：运行中 + 选中 → 切换 animation-name（呼吸继续），不再有 animation:none
 *   [2] 开发节点：两套 keyframes 的强度差（选中版波谷更高、光晕更宽、含青色选择环）
 *   [3] 任务节点：每个状态都有 --task-glow-rgb；「状态 + .sel」组合规则覆盖全部状态
 *   [4] 任务节点：阻塞中的闪烁选中后换成更亮的一套动画
 *   [5] 全仓 CSS：没有任何节点级 .sel 规则把呼吸动画停掉
 *   [6] 亮色主题：选中环换主题蓝 + 状态灯三元组浅底版，.sel 组合规则齐全
 *   [7] JS 接线：dev-running / st-<status> 类仍然由渲染层写入 */
const fs = require("fs");
const path = require("path");

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
/* 读源码并统一换行：CSS 在 Windows 工作区里常是 CRLF，锚点串按 \n 写就好 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

const css = read("renderer/css/canvas.css");
const cssLight = read("renderer/css/theme-light.css");
const jsCanvas = read("renderer/app-canvas.js");

function blockFrom(src, anchorIndex) {
  if (anchorIndex < 0) return null;
  const open = src.indexOf("{", anchorIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(open, i + 1);
    }
  }
  return null;
}
/* 整条规则的选择器表 + 规则体（anchor 之后到下一个空行，规则之间以空行分隔）。
   fromEnd = true 取最后一次出现：同一条选择器既是「组合规则」的结尾、
   又是紧随其后的独立规则（animation-name）的开头时，需要用最后一次。 */
function ruleText(src, anchor, fromEnd) {
  const at = fromEnd ? src.lastIndexOf(anchor) : src.indexOf(anchor);
  if (at < 0) return null;
  const blank = src.indexOf("\n\n", at);
  const body = blockFrom(src, at);
  if (!body) return null;
  const end = blank < 0 ? src.length : blank;
  return src.slice(at, Math.max(end, src.indexOf("}", at)));
}
/* 取 @keyframes 块 */
function kfBlock(src, name) {
  const at = src.indexOf("@keyframes " + name);
  if (at < 0) return "";
  return blockFrom(src, at) || "";
}
/* 抠出 --dev-glow(...) 里的 alpha 序列（用于比较常态与选中态强度） */
function glowAlphas(s, varName) {
  const re = new RegExp(varName + "[^)]*\\),\\s*(0?\\.\\d+|1)\\)", "g");
  const out = [];
  let m;
  while ((m = re.exec(s))) out.push(parseFloat(m[1]));
  return out;
}

console.log("\n[1] 开发节点：运行中 + 选中 → 呼吸不熄灭");
{
  const sel = ".wf-node.super.dev-el.dev-running.sel {";
  const body = ruleText(css, sel);
  ok(!!body, "canvas.css：存在带 .super 抬权重的「运行中 + 选中」规则（压过 .wf-node.sel 的描边）");
  ok(!!body && body.includes("animation-name: devRunBreatheSel"), "选中只切换 animation-name → 呼吸继续进行");
  ok(!!body && !/animation:\s*none/.test(body), "选中规则里不再出现 animation:none（老毛病：一点选就停）");
  ok(!!body && /outline:\s*2px/.test(body), "选中规则带 2px 选择环（呼吸灯与选中高亮同时可见）");
  const base = ruleText(css, ".wf-node.dev-el.dev-running {");
  ok(!!base && base.includes("animation: devRunBreathe 1.9s"), "常态：1.9s 呼吸动画照常声明");
  ok(!!base && base.includes("--dev-sel-rgb"), "常态规则里备着选中环颜色变量（主题可换）");
}

console.log("\n[2] 开发节点：两套 keyframes 的强度差");
{
  const kf = kfBlock(css, "devRunBreathe");
  const kfs = kfBlock(css, "devRunBreatheSel");
  ok(!!kf && !!kfs, "devRunBreathe / devRunBreatheSel 两套动画都在");
  const a = (s) => glowAlphas(s, "--dev-glow");
  const trough = (s) => a(s)[0];
  const peak = (s) => (a(s).length ? Math.max.apply(null, a(s)) : 0);
  ok(kfs.includes("26px") && kf.includes("16px"), "选中版光晕更宽（16px → 26px）");
  ok(peak(kfs) > peak(kf), "选中版波峰更亮：" + peak(kf) + " → " + peak(kfs));
  ok(trough(kfs) > trough(kf), "选中版波谷被抬高（不再有一段明显暗下去）：" + trough(kf) + " → " + trough(kfs));
  ok(kfs.includes("--dev-sel-rgb") && !kf.includes("--dev-sel-rgb"), "青色选择环只写进选中版动画（未选中保持干净）");
}

console.log("\n[3] 任务节点：状态灯三元组 + 「状态 + .sel」组合规则");
{
  const states = [
    [".wf-node.task.st-done {", "95, 214, 138"],
    [".wf-node.task.st-running,", "255, 143, 46"],
    [".wf-node.task.st-failed {", "255, 107, 107"],
    [".wf-node.task.st-blocked,", "255, 224, 138"],
  ];
  for (const [sel, rgb] of states) {
    const body = ruleText(css, sel);
    ok(!!body && body.includes("--task-glow-rgb: " + rgb), sel.replace(/ \{$/, "").replace(/,$/, "") + " 声明 --task-glow-rgb（选中规则读它）");
  }
  ok(/\.wf-node\.task \{[\s\S]{0,300}?--task-sel-rgb/.test(css), ".wf-node.task 备着选中环颜色 --task-sel-rgb");
  const selAll = ruleText(css, ".wf-node.task.st-done.sel,");
  ok(!!selAll, "存在「状态 + .sel」组合规则");
  for (const cls of ["st-done", "st-running", "st-run", "st-failed", "st-blocked", "st-block"]) {
    ok(!!selAll && selAll.includes(".wf-node.task." + cls + ".sel"), "组合规则覆盖 ." + cls + ".sel（状态色不再被 .task.sel 换掉）");
  }
  const selRule = blockFrom(css, css.indexOf(".wf-node.task.st-done.sel,"));
  /* 边框直接取该状态的满值色（变量在各状态规则里声明，这里留一份兜底值） */
  ok(!!selRule && /border-color:\s*rgb\(var\(--task-glow-rgb/.test(selRule), "选中版边框 = 该状态满值颜色（状态灯保留）");
  ok(!!selRule && selRule.includes("rgba(var(--task-glow-rgb") && selRule.includes("--task-sel-rgb"), "选中版状态光晕加宽 + 叠一圈青色选择光晕");
  ok(!!selRule && /outline:\s*2px solid rgba\(var\(--task-sel-rgb/.test(selRule), "选中版带 outline 选择环（与开发节点同一手法）");
  /* 权重与顺序都必须赢过那条通用选中规则，否则状态色还是会被盖掉 */
  const at = css.indexOf(".wf-node.task.sel {");
  const selAt = css.indexOf(".wf-node.task.st-done.sel,");
  ok(at > 0 && selAt > at, "组合规则写在 .wf-node.task.sel 之后（同分时靠顺序取胜）");
  ok(!!selRule && !/animation:\s*none/.test(selRule), "任务节点选中规则不含 animation:none");
}

console.log("\n[4] 任务节点：阻塞中的闪烁选中后更亮");
{
  const body = ruleText(css, ".wf-node.task.st-block.sel {", true);
  ok(!!body && body.includes("animation-name: task-block-blink-sel"), "只切换 animation-name → 闪烁继续进行");
  const kf = kfBlock(css, "task-block-blink");
  const kfs = kfBlock(css, "task-block-blink-sel");
  ok(!!kf && !!kfs, "task-block-blink / task-block-blink-sel 两套动画都在");
  ok(kfs.includes("22px") && kf.includes("14px"), "选中版闪烁光晕更宽（14px → 22px）");
  const tr = glowAlphas(kfs, "--task-glow-rgb")[0];
  ok(tr >= 0.5, "选中版波谷抬高（常态波谷只有 .25 光晕 / 暗金边）：实测 " + tr);
  ok(kfs.includes("--task-sel-rgb") && !kf.includes("--task-sel-rgb"), "青色选择光晕只写进选中版");
  ok(kfs.includes("var(--nfloat)") && kf.includes("var(--nfloat)"), "两套动画都保住了节点浮空投影");
}

console.log("\n[5] 全仓 CSS：没有节点级 .sel 规则停掉呼吸");
{
  const files = [
    ["canvas.css", css],
    ["theme-light.css", cssLight],
    ["components.css", read("renderer/css/components.css")],
    ["assist.css", read("renderer/css/assist.css")],
    ["dsh.css", read("renderer/css/dsh.css")],
    ["layout.css", read("renderer/css/layout.css")],
  ];
  const bad = [];
  for (const [file, src] of files) {
    const re = /(^|\n)([^{}\n]*\.wf-node[^{}\n]*\.sel[^{}\n]*)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      if (/animation:\s*none/.test(m[3])) bad.push(file + " → " + m[2].trim());
    }
  }
  ok(bad.length === 0, "没有 .wf-node….sel { animation:none } 这种「选中即停」的规则" + (bad.length ? "：" + bad.join(" | ") : ""));
}

console.log("\n[6] 亮色主题：状态灯与选中环一起换色");
{
  ok(/body\.theme-light \.wf-node\.task \{ --task-sel-rgb: 91, 159, 216/.test(cssLight), "亮色主题选中环换主题蓝（浅底上青色霓虹会发灰）");
  const lightRun = ruleText(cssLight, "body.theme-light .wf-node.task.st-running,", true);
  ok(!!lightRun && /--task-glow-rgb/.test(lightRun), "亮色主题为运行中状态重设灯色三元组");
  const lightSel = ruleText(cssLight, "body.theme-light .wf-node.task.st-done.sel,");
  ok(!!lightSel, "亮色主题也有一条「状态 + .sel」组合规则");
  for (const cls of ["st-done", "st-running", "st-run", "st-failed", "st-blocked", "st-block"]) {
    ok(!!lightSel && lightSel.includes(".wf-node.task." + cls + ".sel"), "亮色主题组合规则覆盖 ." + cls + ".sel");
  }
  ok(!!lightSel && /outline:\s*2px solid rgba\(var\(--task-sel-rgb/.test(lightSel), "亮色主题选中环走变量（自动是主题蓝，不是霓虹青）");
  const lightDev = ruleText(cssLight, "body.theme-light .wf-node.super.dev-el.dev-running.sel {");
  ok(!!lightDev, "开发节点「运行中 + 选中」在亮色主题下同样加强（不是关掉）");
  ok(!!lightDev && !/animation:\s*none/.test(lightDev), "亮色主题那条规则不含 animation:none");
}

console.log("\n[7] JS 接线：状态类仍然写进节点元素");
{
  ok(jsCanvas.includes('el.classList.add("dev-running", "dev-running-"'), "开发节点运行中 → nodeElement 加 .dev-running（+ self/desc/sess 细分）");
  ok(/el\.classList\.add\("st-" \+ st\)/.test(jsCanvas), "任务节点 → nodeElement 加 st-<taskStatus>（running/done/failed/blocked 的状态灯来源）");
  ok(/el\.className = "wf-node " \+ kindCls \+ \(isSel\(node\.id\) \? " sel" : ""\)/.test(jsCanvas), "选中态用 .sel 类叠加（CSS 组合规则的前提）");
  ok(jsCanvas.includes('hostEl.classList.add("sel")'), "拖拽尺寸的快速路径也只加 .sel 类（不重绘 → 靠切 animation-name 才有效）");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-state-sel)"
    : "\n✓ " + checks + " 项全部通过  (smoke-node-state-sel)",
);
process.exit(fails ? 1 : 0);
