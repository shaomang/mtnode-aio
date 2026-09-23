"use strict";
/* 一次性取证：smoke-token-budget 里那两条断言是否在本次改动之前就已过期。
   点名的两处代码都由别的会话改过，本脚本只读，不写任何文件。 */
const fs = require("fs");
const path = require("path");
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, rel.split("/").join(path.sep)), "utf8").replace(/\r\n?/g, "\n");
const NODES = read("renderer/app-nodes.js");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const TEST = read("test/smoke-token-budget.js");

const a = 'return o.detail === "minimal" ? pruneMinimalSnapshot(snap, opts) : snap;';
const a2 = 'const out = o.detail === "minimal" ? pruneMinimalSnapshot(snap, opts) : snap;';
console.log("A 断言串在 test 里：", TEST.indexOf('has(NODES_SRC, "' + a + '"') >= 0);
console.log("A 旧串在源码里：", NODES.indexOf(a) >= 0);
console.log("A 新串在源码里：", NODES.indexOf(a2) >= 0);

const b = "the build references (kinds, imageSizes, defaultImageSize, markColors, devFuncColors 功能色卡, cam / view)";
console.log("B 断言串在 test 里：", TEST.indexOf(b) >= 0);
console.log("B 旧串在源码里：", PLUGIN.indexOf(b) >= 0);
console.log("B 新串在源码里：", PLUGIN.indexOf("the build references (markColors, devFuncColors 功能色卡, cam / view)") >= 0);
console.log("B 网关 #148 那条 description 串：", PLUGIN.indexOf("(kinds, imageSizes, defaultImageSize, markColors, devFuncColors, cam/view)") >= 0);
console.log("静态表闸函数存在：", NODES.indexOf("function snapshotWantsStaticRefs") >= 0);
console.log("portRule 挂点在源码里：", NODES.indexOf('if (o.detail !== "minimal") node.portRule = snapshotDynamicPortRule(n);') >= 0);