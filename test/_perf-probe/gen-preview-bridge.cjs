/* test/_perf-probe/gen-preview-bridge.cjs —— 生成 preview-bridge.js
 *
 * 把 apps-store.js 里那段 PREVIEW_BRIDGE（预览宿主桥小助手）**逐字**抽出来，供
 * test/_perf-probe/app-window-vs-preview.cjs 在不 require apps-store.js（它会挂 IPC /
 * 注册协议，依赖 main.js 注进来的一堆东西）的前提下，也能在预览帧里注入**真源那一份**。
 *
 * 用法：node test/_perf-probe/gen-preview-bridge.cjs
 * 口径：apps-store.js 里那段改了（字符串表变动）就要重跑本脚本，否则对照台测的是旧桥。
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const src = fs.readFileSync(path.join(ROOT, "apps-store.js"), "utf8");

function arrayLit(name) {
  const i = src.indexOf("const " + name + " = [");
  if (i < 0) throw new Error("apps-store.js 里找不到 " + name);
  const j = src.indexOf("].join(", i);
  if (j < 0) throw new Error(name + " 的数组字面量没有闭合");
  return src.slice(i + ("const " + name + " = ").length, j + 1);
}

const PREVIEW_K = "__mtnodePreview";
/* 真源里这段表用的是模板占位（第 385 行那个 K），这里给它同一个词，再把 join 出来的整段拿回来 */
const bridge = new Function("PREVIEW_K", "return " + arrayLit("PREVIEW_BRIDGE") + ".join(\"\\n\");")(PREVIEW_K);

const out =
  "/* test/_perf-probe/preview-bridge.js —— apps-store.js 的 PREVIEW_BRIDGE 源码逐字副本（自动生成）\n" +
  " * 生成：node test/_perf-probe/gen-preview-bridge.cjs（apps-store.js 里那段改了就要重跑）\n" +
  " * 用途：只读对照台 app-window-vs-preview.cjs 往预览帧里注入与产品同一份桥。 */\n" +
  "module.exports = " +
  JSON.stringify(bridge) +
  ";\n";
fs.writeFileSync(path.join(__dirname, "preview-bridge.js"), out, "utf8");
console.log("ok bytes=" + out.length + " bridgeLen=" + bridge.length);
