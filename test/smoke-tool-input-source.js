"use strict";
/* 「文本节点 → 工具节点入参」取值与空值诊断 + 输入节点菜单 —— 链路级冒烟（纯 Node）
 *   node test/smoke-tool-input-source.js
 * 背景（本次需求）：用户把「文本节点」接到工具节点（如内置 markdown-to-pdf）的第 3 个
 *   数据端子（输出路径）后，工具仍报「缺少输出路径」。实测根因是文本节点一旦挂上入线就
 *   进入**继承态**（app.js inputInherited / valueForInput），它自己写的正文不参与取值 ——
 *   上游没出值时下游拿到的就是空串，报错内容与用户看到的一模一样。
 *   取值语义按用户选择保留不动（有入线就读上游），要求把「哪个入参没取到值、为什么、
 *   断在哪一环」在节点上直接提示出来；同时把「文本节点」加进画布右键「输入节点（仅输出）」
 *   那一组、排在「文件节点」之上。
 * 被测代码是真实源码切片 / 真实函数，不是抄一份逻辑：
 *   renderer/app.js        valueForInput / inputInherited / superExternalInWiresAll /
 *                          externalValueIntoSuper / 工具端子类型归一 / canvasCreateMenuGroups
 *   renderer/app-nodes.js  fnInputSrcNoteLegacyTrap / fnInputProviderNode / fnInputBlankReason /
 *                          computePortValue / functionInputObject（_inputNotes 诊断）
 *   renderer/app-canvas.js fnToolInputNotesEl / 继承态提示 / 菜单顺序（源码断言）
 * 覆盖：
 *   [1] 正常形态：文本节点（无入线）→ 工具端子3 → 内部函数：值一路到位，且不产生任何提示
 *   [2] 用户报的形态：文本节点挂入线（继承态）+ 上游无输出 → 值为空 + 提示点名真正的文本节点
 *   [3] 上溯穿透：线接在工具节点外侧 → 内部函数拿到的来源是「壳」，提示必须穿到壳外面那个节点
 *   [4] 归因不误报：上游有值时不出提示；来源不是文本节点时用「上游还没跑」那条文案
 *   [5] 菜单：画布右键「输入节点（仅输出）」组里「文本节点」排在「文件节点」之上
 *   [6] 接线：文本节点 → 工具节点参数端子放行；控制端子/被占端子/图像端子仍按既有口径挡下
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

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");

/* 按「顶层 function 声明行」逐个切片：从该行到下一个顶层声明行（或文件尾） */
function sliceFns(src, names) {
  const lines = src.split("\n");
  const headRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = headRe.exec(lines[i]);
    if (m) starts.push({ i, name: m[1] });
  }
  const out = [];
  for (const nm of names) {
    const k = starts.findIndex((s) => s.name === nm);
    if (k < 0) {
      out.push("/* 缺失：" + nm + " */");
      continue;
    }
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    out.push(lines.slice(starts[k].i, end).join("\n"));
  }
  return out.join("\n");
}

/* 轻量 I18n 桩：{var} 占位按真实口径替换，便于对文案断言 */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

const APP_FNS = [
  "nodeParentSuperId",
  "isSuperNode",
  "isSuperLikeNode",
  "isSuperIoNode",
  "nodeByIdIn",
  "superExternalInWiresAll",
  "superExternalInWires",
  "superInternalOutFeedsAll",
  "superInternalOutFeeds",
  "superInternalBridgeWiresAll",
  "superInternalBridgeWires",
  "externalValueIntoSuper",
  "valueForSuperOutput",
  "valueFromWire",
  "superPortIdxFromWire",
  "nodeById",
  "isControlKind",
  "isTextSource",
  "inputInherited",
  "isToolNode",
  "isFunctionNode",
  "isFnToolNode",
  "fnToolInPortIsControl",
  "fnToolOutPortIsControl",
  "fnToolParamList",
  "fnToolPortKind",
  "normPortValueByKind",
  "normFnToolPortValue",
  "normFnToolEntry",
  "parseSimpleYaml",
  "valueForInput",
  "inboundWire",
  "wireSourceIndex",
];

const PRELUDE = `
var S = { wf: null };
var window = {};
var U = 0;
function uid(p){ U++; return (p||'n') + U; }
function toast(){}
function currentSuperFocus(){ return ''; }
function superIsOpenShell(){ return false; }
function isItemPortSource(){ return false; }
function assetItems(){ return []; }
function assetItemValueOf(){ return null; }
function mediaInputValueOf(){ return null; }
function selResult(){ return null; }
function taskSummaryText(){ return ''; }
function splitSelected(){ return null; }
function mergeItems(){ return []; }
function isAssetNode(){ return false; }
function isVideoPostKind(){ return false; }
function isMediaGenNode(){ return false; }
function allTextItems(){ return []; }
function allImageItems(){ return []; }
function itemTitleOf(){ return ''; }
function superDynamicPortCount(maxIdx){ return Math.max(1, Number(maxIdx||0)+1); }
function superInPortIsControl(){ return false; }
function superOutPortIsControl(){ return false; }
function wiresTo(id){ return ((S.wf && S.wf.wires) || []).filter(function(w){ return w.to === id; }); }
function fnToolInPortIsArray(){ return false; }
`;

const SB = vm.createContext({ console, window: {}, document: undefined, I18n: I18N_STUB });
vm.runInContext(PRELUDE, SB);
vm.runInContext(sliceFns(APP, APP_FNS), SB);
vm.runInContext(
  sliceFns(NODES, [
    "fnInputSrcNoteLegacyTrap",
    "fnInputProviderNode",
    "fnInputValueIsBlank",
    "fnInputBlankReason",
    "computePortValue",
    "functionInputObject",
  ]),
  SB,
);

const E = (code) => vm.runInContext(code, SB);
function J(expr) {
  return JSON.parse(E("JSON.stringify(" + expr + ")"));
}

/* ── 夹具：文本节点 → 工具节点(端子3) → 内部函数节点(端子3) ───────────────── */
function makeWf(extraNodes, extraWires) {
  const wf = {
    id: "w1",
    nodes: [
      {
        id: "txt1",
        kind: "input_text",
        title: "文本节点",
        parentSuperId: "",
        x: 0,
        y: 0,
        text: "D:\\out\\报告.pdf",
        entries: [],
        batch: false,
      },
      {
        id: "tool1",
        kind: "super",
        tool: true,
        title: "Markdown 转 PDF",
        parentSuperId: "",
        x: 300,
        y: 0,
        toolConfig: {
          name: "Markdown 转 PDF",
          inputs: [
            { name: "Markdown内容", kind: "text", optional: true },
            { name: "源文件路径", kind: "text", optional: true },
            { name: "输出路径", kind: "text" },
          ],
          outputs: [
            { name: "文件路径", kind: "text" },
            { name: "字节数", kind: "text" },
          ],
          atLeastOne: [["Markdown内容", "源文件路径"]],
        },
      },
      {
        id: "fn1",
        kind: "function",
        title: "Markdown → PDF 落盘",
        parentSuperId: "tool1",
        x: 60,
        y: 60,
        inputs: [
          { name: "Markdown内容", kind: "text" },
          { name: "源文件路径", kind: "text" },
          { name: "输出路径", kind: "text" },
        ],
        outputs: [
          { name: "文件路径", kind: "text" },
          { name: "字节数", kind: "text" },
        ],
      },
    ],
    wires: [
      { id: "w1", from: "txt1", to: "tool1", fromIndex: 0, toIndex: 3 },
      { id: "w2", from: "tool1", to: "fn1", fromIndex: 3, toIndex: 3 },
    ],
  };
  for (const n of extraNodes || []) wf.nodes.push(n);
  for (const w of extraWires || []) wf.wires.push(w);
  return wf;
}
const setWf = (wf) => {
  SB.S = { wf: wf };
};

/* ═════════════ [1] 正常形态：值到位且不产生提示 ═════════════ */
console.log("\n[1] 正常形态（文本节点无入线）：值一路到内部函数，且不产生任何「没取到值」提示");
setWf(makeWf());
ok(
  JSON.stringify(J('valueForInput(nodeById("txt1"), 0, nodeById("tool1"))')) ===
    JSON.stringify({ kind: "text", text: "D:\\out\\报告.pdf" }),
  "[1] 文本节点的值 = {kind:'text', text:'D:\\out\\报告.pdf'}",
);
ok(
  J('externalValueIntoSuper(nodeById("tool1"), 3)').text === "D:\\out\\报告.pdf",
  "[1] 工具节点外侧端子 3 取到同一段文本（参数即端子 · 端子3 = 输出路径）",
);
const in1 = J('(function(){ var o = functionInputObject(nodeById("fn1")); return { p: o["输出路径"], d: o.$3, notes: nodeById("fn1")._inputNotes }; })()');
ok(
  in1.p && in1.p.text === "D:\\out\\报告.pdf" && in1.d && in1.d.text === "D:\\out\\报告.pdf",
  "[1] 内部函数入参「输出路径」与 $3 都拿到该值（命名键与端子号两条口径一致）",
);
ok(Array.isArray(in1.notes) && in1.notes.length === 0, "[1] 值到位 → 不产生任何提示（不误报）");

/* ═════════════ [2] 用户报的形态：继承态 + 上游无输出 ═════════════ */
console.log("\n[2] 用户报的形态：文本节点挂入线（继承态）+ 上游无输出 → 空值 + 点名真正的文本节点");
const up = {
  id: "up1",
  kind: "proc_text",
  title: "文本处理（LLM）",
  parentSuperId: "",
  x: -300,
  y: 0,
};
setWf(makeWf([up], [{ id: "w0", from: "up1", to: "txt1", fromIndex: 0, toIndex: 0 }]));
ok(E('inputInherited(nodeById("txt1"))') === true, "[2] 文本节点有入线 → inputInherited 为真（进入继承态）");
ok(E('valueForInput(nodeById("txt1"), 0, nodeById("tool1"))') === null, "[2] 节点自己写的正文被忽略：取值为 null（这就是「缺少输出路径」的来源）");
const in2 = J('(function(){ var o = functionInputObject(nodeById("fn1")); return { p: o["输出路径"], notes: nodeById("fn1")._inputNotes }; })()');
ok(in2.p == null, "[2] 内部函数入参「输出路径」为 null（内置 jscode 此刻就会抛「缺少输出路径」）");
ok(
  Array.isArray(in2.notes) && in2.notes.length === 1,
  "[2] 恰好产生 1 条提示（空值才提示）",
);
ok(
  in2.notes.length === 1 &&
    in2.notes[0].indexOf("输出路径") >= 0 &&
    in2.notes[0].indexOf("文本节点") >= 0 &&
    in2.notes[0].indexOf("继承态") >= 0,
  "[2] 提示点名参数「输出路径」+ 来源文本节点 + 说明是继承态吃掉了正文",
);
ok(
  in2.notes.length === 1 && in2.notes[0].indexOf("{p}") < 0 && in2.notes[0].indexOf("{s}") < 0,
  "[2] 占位符已按真实 I18n 口径替换（卡片上不会出现 {p} / {s}）",
);

/* ═════════════ [3] 上溯穿透 ═════════════ */
console.log("\n[3] 上溯穿透：内部函数的直接来源是工具节点壳，提示必须穿到壳外面那个文本节点");
ok(
  E('(function(){ var w = wiresTo("fn1")[0]; var s = nodeById(w.from); return s.kind === "super" && fnInputSrcNoteLegacyTrap(s) === false; })()') === true,
  "[3] 内部函数的直接来源确实是壳（kind=super），壳自己不是继承态文本节点",
);
ok(
  E('fnInputProviderNode(nodeById("tool1")) && fnInputProviderNode(nodeById("tool1")).id === "txt1"') === true,
  "[3] fnInputProviderNode 沿壳上溯到真正供值的文本节点（否则用户照着提示找不到该改哪个节点）",
);
ok(
  E('fnInputProviderNode(nodeById("txt1")) === nodeById("txt1")') === true,
  "[3] 不是壳的节点原样返回（不穿透普通节点）",
);
/* 壳自己没有外侧输入线 → 上溯返回 null，提示回落用壳本身的名字，不崩 */
setWf(
  makeWf([], [{ id: "w2", from: "tool1", to: "fn1", fromIndex: 3, toIndex: 3 }]).valueOf(),
);
SB.S.wf.wires = SB.S.wf.wires.filter((w) => !(w.from === "txt1" && w.to === "tool1"));
const in3 = J('(function(){ var o = functionInputObject(nodeById("fn1")); return { p: o["输出路径"], notes: nodeById("fn1")._inputNotes }; })()');
ok(
  in3.p == null && in3.notes.length === 1 && in3.notes[0].indexOf("Markdown 转 PDF") >= 0,
  "[3] 壳上没有外侧输入线（这一环就是断点）→ 提示回落点名壳，仍给出可读文案",
);

/* ═════════════ [4] 归因不误报 / 另一种空值原因 ═════════════ */
console.log("\n[4] 归因口径：上游有值不出提示；来源不是文本节点时用「上游还没跑」那条文案");
SB.S.wf.nodes.push({
  id: "up1",
  kind: "proc_text",
  title: "文本处理（LLM）",
  parentSuperId: "",
});
SB.S.wf.wires.push({ id: "w0", from: "up1", to: "txt1", fromIndex: 0, toIndex: 0 });
/* 让上游出值：改用「无入线的文本节点直接接工具端子 3」的等价夹具 */
setWf(
  makeWf(
    [
      { id: "txt2", kind: "input_text", title: "文本节点 2", parentSuperId: "", text: "D:\\out\\ok.pdf", entries: [], batch: false },
    ],
    [{ id: "w9", from: "txt2", to: "tool1", fromIndex: 0, toIndex: 3 }],
  ).valueOf(),
);
/* 上面这条线让工具端子 3 有两根线（旧的一根来自 txt1）——按「一号一值」先挂的生效，
   这里改造成单一来源：直接去掉 txt1→tool1 那根 */
SB.S.wf.wires = SB.S.wf.wires.filter((w) => !(w.from === "txt1" && w.to === "tool1"));
const in4 = J('(function(){ var o = functionInputObject(nodeById("fn1")); return { p: o["输出路径"], notes: nodeById("fn1")._inputNotes }; })()');
ok(
  in4.p && in4.p.text === "D:\\out\\ok.pdf" && in4.notes.length === 0,
  "[4] 换成有值的来源 → 取到值且提示清零（不会留着上一轮的旧提示）",
);
/* 来源非文本节点、且没输出 → 「上游还没跑」文案 */
setWf(
  makeWf(
    [{ id: "pr1", kind: "proc_text", title: "文本处理（LLM）", parentSuperId: "" }],
    [{ id: "w9", from: "pr1", to: "tool1", fromIndex: 0, toIndex: 3 }],
  ),
);
SB.S.wf.wires = SB.S.wf.wires.filter((w) => !(w.from === "txt1" && w.to === "tool1"));
const in5 = J('(function(){ var o = functionInputObject(nodeById("fn1")); return { p: o["输出路径"], notes: nodeById("fn1")._inputNotes }; })()');
ok(
  in5.p == null && in5.notes.length === 1 && in5.notes[0].indexOf("暂时没有输出") >= 0,
  "[4] 来源不是继承态文本节点 → 用「来源暂时没有输出」文案（不冤枉成继承态）",
);
ok(
  E('fnInputValueIsBlank(null) && fnInputValueIsBlank("   ") && fnInputValueIsBlank({kind:"text",text:" \\n "}) && !fnInputValueIsBlank(" x ")') === true,
  "[4] 空白判定：null / 纯空白串 / 空白文本值都算「没取到值」，非空串不算",
);

/* ═════════════ [5] 菜单：文本节点排在文件节点之上 ═════════════ */
console.log("\n[5] 画布右键「输入节点（仅输出）」组：文本节点 + 文件节点，且文本节点在前");
const menuSrc = (() => {
  const i = APP.indexOf("function canvasCreateMenuGroups(pt) {");
  const j = APP.indexOf("\nfunction ", i + 10);
  return APP.slice(i, j > i ? j : i + 12000);
})();
const iText = menuSrc.indexOf('"input_text"');
const iAny = menuSrc.indexOf('"input_any"');
ok(iText > 0, "[5] 菜单里出现 input_text 一项（文本节点直接可建）");
ok(iAny > 0, "[5] 菜单里文件节点（input_any）仍在");
ok(iText > 0 && iAny > 0 && iText < iAny, "[5] 「文本节点」排在「文件节点」之上（用户确认的位置）");
ok(
  APP.indexOf('I18n.t("文本节点（直接写文字 / 路径）")') > 0,
  "[5] 菜单项文案 = 文本节点（直接写文字 / 路径）",
);
ok(
  APP.indexOf('addNode("input_text", pt.x, pt.y)') > 0,
  "[5] 点它建的就是普通文本节点（不新增节点类型）",
);

/* ═════════════ [6] 卡片提示接线 + i18n 齐备（源码断言） ═════════════ */
console.log("\n[6] 卡片提示与词条接线");
ok(
  CANVAS.indexOf("function fnToolInputNotesEl(node) {") > 0 &&
    /body\.appendChild\(fnToolInputNotesEl\(node\)\);/.test(CANVAS),
  "[6] 工具 / 函数节点卡片画出「入参没取到值」提示块（fnToolInputNotesEl 接线在 buildFnToolBodyMain）",
);
ok(
  CANVAS.indexOf("本节点正文不参与取值（已连入线 = 继承态）：断开入线才用正文，或先让上游出值") > 0,
  "[6] 继承态文本节点在上游为空时直接说明「正文不参与取值」",
);
ok(
  CANVAS.indexOf("；本节点自己写的正文不参与取值") > 0,
  "[6] 继承态「只读」徽标的悬浮提示补上「正文不参与取值」",
);
ok(
  CANVAS.indexOf('fix.textContent = I18n.t("改用正文（断开入线）")') > 0 &&
    CANVAS.indexOf("已断开入线：本节点改为使用自己写的正文") > 0,
  "[6] 给出一条正面出路：一键「改用正文（断开入线）」（可 Ctrl+Z 撤销）",
);
ok(
  NODES.indexOf("node._inputNotes = notes;") > 0 &&
    NODES.indexOf("console.warn(String(node.title || node.id)") > 0,
  "[6] 诊断写进 node._inputNotes（运行态脏字段）+ console.warn（可回溯）",
);
ok(
  NODES.indexOf('if (callArgs) {') < NODES.indexOf("const notes = [];"),
  "[6] Agent 注入路径（_agentCallArgs）不参与画布连线诊断（口径未动）",
);
const I18N = read("renderer/i18n.js");
const I18N_KEYS = [
  "文本节点（直接写文字 / 路径）",
  "；本节点自己写的正文不参与取值",
  "本节点正文不参与取值（已连入线 = 继承态）：断开入线才用正文，或先让上游出值",
  "继承态下节点正文只作历史保留，下游拿到的是上游的值（上游为空就是空）",
  "入参没取到值（",
  " 个）：",
  "改用正文（断开入线）",
  "已断开入线：本节点改为使用自己写的正文（Ctrl+Z 可撤销）",
  "参数「{p}」没取到值：来源文本节点「{s}」挂着上游连线（继承态），它自己写的正文不参与取值 —— 请断开这根入线用正文，或先让上游出值",
  "参数「{p}」没取到值：来源「{s}」暂时没有输出（上游还没跑或结果为空）",
];
/* i18n 口径（renderer/i18n.js 头注释写死的结构）：EN 的键 = 中文原文，值 = 英文译文；
   zh 界面直接回显键本身 —— 所以**新中文文案只需进 EN 一次**，但必须有非空英文译文。 */
const I18N_EN_BLOCK = (() => {
  const s = I18N.indexOf("var EN = {");
  const e = I18N.indexOf("\n      };", s);
  return s >= 0 && e > s ? I18N.slice(s, e) : I18N;
})();
for (const k of I18N_KEYS) {
  const i = I18N_EN_BLOCK.indexOf('"' + k + '":');
  if (i < 0) {
    ok(false, "[6] 词条缺英文条目：" + k.slice(0, 24));
    continue;
  }
  const after = I18N_EN_BLOCK.slice(i + k.length + 3);
  const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(after);
  const en = m ? m[1] : "";
  ok(!!en && !/[\u4e00-\u9fff]/.test(en), "[6] 词条有非空英文译文：" + k.slice(0, 22));
}

console.log("\n" + (fails ? "FAIL" : "全部通过") + "：" + (checks - fails) + "/" + checks);
process.exit(fails ? 1 : 0);
