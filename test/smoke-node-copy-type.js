"use strict";
/* test/smoke-node-copy-type.js — 顶栏「复制」（Ctrl+D）：复制同类节点（只复制类型） 回归
 * ============================================================================
 * 运行：node test/smoke-node-copy-type.js
 *
 * 钉住的需求：
 *   · 顶栏菜单栏有一颗「复制」按钮（#btnDupNode），快捷键 Ctrl+D；
 *   · 按下后立刻在「选中节点正下方」新建一颗同类节点；
 *   · 只复制「类型」——正文 / 提示词 / 参数 / 输出 / 连线 / 子节点 / 原标题一律不带；
 *   · 泛用「文件节点」（input_any）上传 / 手动转换后复制的是「更改后的类型」（kind
 *     已就地换成 input_text / input_image / …）；工具节点（落盘 super + tool:true）
 *     复制出来的仍是工具节点；
 *   · 固定起点 / 终点（ctrlPinned）不可复制。
 *
 * 其中 [4] 把 renderer/app.js 里的 duplicateSelectedNodeBelow / copyKindOfNode 抠进 vm
 * 真跑一遍（最小替身），验证「下方」「只类型」「工具还原为 tool」三件事；其余为只读断言。
 * 只读断言：不改任何文件。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
};

const HTML = read("renderer/index.html");
const APP = read("renderer/app.js");
const BOOT = read("renderer/app-boot.js");
const KEYS = read("renderer/app-keys.js");
const I18N = read("renderer/i18n.js");

/* ---------- 从源码里按名字抠出顶层函数（与 smoke-file-node 同一口径） ---------- */
function slice(src, name) {
  const at = src.search(
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
  );
  if (at < 0) throw new Error("找不到源码：" + name);
  const start = at + 1;
  const i = src.indexOf("{", start);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j);
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(start, j + 1);
    }
  }
  throw new Error("函数体不闭合：" + name);
}

console.log("[1] 顶栏「复制」按钮 + Ctrl+D 提示");
{
  const at = HTML.indexOf('id="btnDupNode"');
  ok(at >= 0, "index.html 有 #btnDupNode");
  const tag = at >= 0 ? HTML.slice(HTML.lastIndexOf("<button", at), HTML.indexOf(">", at) + 1) : "";
  has(tag, 'class="corner mini btn-ico"', "沿用顶栏既有范式（.corner.mini.btn-ico）");
  has(tag, 'aria-label="复制"', "aria-label = 复制");
  has(tag, "Ctrl+D", "标题写明快捷键 Ctrl+D");
  ok(/data-i18n-title="复制节点（Ctrl\+D）/.test(tag), "data-i18n-title 是 hover 提示真源");
  hasnt(tag, "data-shortcut=", "不挂 data-shortcut（避免与「隐藏线」的 D 单键冲突）");
  has(HTML, '<span class="btn-ico-txt" data-i18n="复制">复制</span>', "按钮文字 = 复制（可切语言）");
  const redoAt = HTML.indexOf('id="btnRedo"');
  const fitAt = HTML.indexOf('id="btnFit"');
  ok(redoAt >= 0 && redoAt < at && at < fitAt, "按钮落在「重做」与「居中」之间（编辑动作同族）");
  has(KEYS, "组合键一律不占", "app-keys.js 仍只管单键（Ctrl+D 不进单键表）");
}

console.log("\n[2] 按钮接线（app-boot.js）");
{
  has(BOOT, 'const btnDupNode = $("#btnDupNode");', "取到 #btnDupNode");
  ok(
    /btnDupNode\.onclick[\s\S]{0,160}duplicateSelectedNodeBelow\(\)/.test(BOOT),
    "点击走 duplicateSelectedNodeBelow()（与 Ctrl+D 同一入口）",
  );
}

console.log("\n[3] Ctrl+D 快捷键分支（app.js 组合键区）");
{
  has(APP, "function duplicateSelectedNodeBelow()", "有 duplicateSelectedNodeBelow()");
  has(APP, "function copyKindOfNode(n)", "有 copyKindOfNode()（类型归一）");
  ok(
    /if \(mod && key === "d" && !ev\.altKey && !ev\.shiftKey\)/.test(APP),
    "Ctrl+D 分支（排除 Alt / Shift 组合）",
  );
  has(APP, "duplicateSelectedNodeBelow();", "分支里直接调用复制函数");
  ok(
    /S\.view !== "workflow"/.test(
      APP.slice(
        APP.indexOf('if (mod && key === "d"'),
        APP.indexOf('if (mod && key === "d"') + 220,
      ),
    ),
    "只在画布视图响应（会话 / 专家团里不误复制）",
  );
  const body = slice(APP, "duplicateSelectedNodeBelow");
  has(body, "makeNode(kind, x, y)", "复制品按类型默认值新建（makeNode）");
  hasnt(body, "cloneNodesDeep", "不走带内容的深拷贝（cloneNodesDeep）");
  hasnt(body, "JSON.parse(JSON.stringify(src))", "不整体克隆源节点（避免带内容）");
  has(body, "isPinnedCtrl", "固定起点 / 终点被排除");
}

console.log("\n[4] 真跑：正下方 · 只复制类型 · 文件 / 工具节点");
{
  const idc = { v: 0 };
  const NODE_DEFAULTS = {
    input_text: { w: 240, h: 130, title: "文本", text: "" },
    input_image: { w: 220, h: 170, title: "图像", imageAsset: "" },
    input_any: { w: 240, h: 130, title: "文件" },
    tool: { w: 320, h: 220, title: "工具", tool: true },
    super: { w: 320, h: 220, title: "超节点" },
  };
  const toasts = [];
  const S = {
    wf: { nodes: [] },
    sel: "",
    selSet: new Set(),
    selGroup: "g",
    selWire: "w",
  };
  let sel = [];
  const ctx = {
    S,
    NODE_DEFAULTS,
    currentSelection: () => sel.slice(),
    isPinnedCtrl: (n) => !!(n && n.ctrlPinned),
    I18n: { t: (s) => s },
    toast: (m) => toasts.push(m),
    grid: () => 24,
    pushHistory: () => {},
    snap: (v) => Math.round(v / 24) * 24,
    uniqueNodeTitle: (t) => {
      const taken = new Set(S.wf.nodes.map((n) => n.title));
      if (!taken.has(t)) return t;
      let i = 2;
      while (taken.has(t + " " + i)) i++;
      return t + " " + i;
    },
    ensureDefaultSavePath: () => {},
    devAutoColorNode: () => {},
    ensureTaskScaffold: () => {},
    renderCanvas: () => {},
    scheduleSave: () => {},
    renderStatus: () => {},
    isMediaGenNode: () => false,
    ensureBackendUiState: () => ({}),
    probeMediaBackend: () => {},
    isToolNode: (n) => !!(n && n.kind === "super" && n.tool === true),
    /* 与真 makeNode 同口径：字段全部来自 NODE_DEFAULTS（不含任何源内容），
       "tool" 创建 kind 换算成落盘形态 "super"（NODE_FORM_OF_KIND） */
    makeNode: (kind, x, y) => {
      const d = NODE_DEFAULTS[kind];
      if (!d) return null;
      const n = { id: "n" + ++idc.v, kind: kind === "tool" ? "super" : kind, x, y, w: d.w, h: d.h };
      for (const [k, v] of Object.entries(d)) {
        if (k === "w" || k === "h") continue;
        n[k] = JSON.parse(JSON.stringify(v));
      }
      return n;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    slice(APP, "copyKindOfNode") +
      "\n" +
      slice(APP, "duplicateSelectedNodeBelow") +
      "\nwindow.__dup = duplicateSelectedNodeBelow;",
    ctx,
  );
  const run = () => vm.runInContext("duplicateSelectedNodeBelow()", ctx);

  /* (a) 普通文本节点：正下方一格 · 不带正文 · 标题回默认 */
  sel = [
    {
      id: "a",
      kind: "input_text",
      x: 120,
      y: 240,
      h: 130,
      title: "我的文本",
      text: "机密正文",
      parentSuperId: "",
      parentTaskId: "",
    },
  ];
  ok(run() === true, "有选中节点时执行成功");
  ok(S.wf.nodes.length === 1, "新增 1 颗节点");
  const n1 = S.wf.nodes[0];
  ok(n1.kind === "input_text", "同类节点：kind 保持 input_text");
  ok(
    n1.x === 120 && n1.y === Math.round((240 + 130 + 24) / 24) * 24,
    "落在选中节点正下方（x 不变，y = 底边 + 一格，吸附网格）",
  );
  ok(!("text" in n1) || n1.text === "", "不复制正文");
  ok(n1.title !== "我的文本", "不使用原标题（标题回类型默认）");
  ok(S.sel === n1.id && S.selSet.has(n1.id), "复制品成为当前选中");

  /* (b) 已转换的泛用文件节点：复制「更改后的类型」 */
  S.wf.nodes.length = 0;
  sel = [{ id: "b", kind: "input_image", x: 0, y: 0, h: 170, title: "图 1", imageAsset: "/x.png" }];
  run();
  ok(S.wf.nodes[0].kind === "input_image", "文件节点上传后的类型（input_image）被复制");
  ok(!S.wf.nodes[0].imageAsset, "不复制图像内容");

  /* (c) 未转换的泛用文件节点：类型仍是文件节点 */
  S.wf.nodes.length = 0;
  sel = [{ id: "c", kind: "input_any", x: 0, y: 0, h: 130, title: "文件节点" }];
  run();
  ok(S.wf.nodes[0].kind === "input_any", "未转换的文件节点复制出文件节点");

  /* (d) 工具节点（落盘 super + tool:true）→ 复制仍是工具节点 */
  S.wf.nodes.length = 0;
  sel = [{ id: "d", kind: "super", tool: true, x: 0, y: 0, h: 220, title: "工具节点" }];
  run();
  ok(S.wf.nodes[0].kind === "super" && S.wf.nodes[0].tool === true, "工具节点复制出工具节点（kind 归一为 tool 再建）");

  /* (e) 固定起点 / 终点不可复制 */
  S.wf.nodes.length = 0;
  toasts.length = 0;
  sel = [{ id: "e", kind: "control", ctrlPinned: true, x: 0, y: 0, h: 60, title: "起点" }];
  run();
  ok(S.wf.nodes.length === 0, "固定节点不被复制");
  ok(toasts.some((m) => /请先选中节点/.test(m)), "没有可复制节点时给出提示");

  /* copyKindOfNode 单独复核 */
  const kindOf = (n) => vm.runInContext("copyKindOfNode", ctx)(n);
  ok(kindOf({ kind: "input_text" }) === "input_text", "普通节点：类型 = kind");
  ok(kindOf({ kind: "super", tool: true }) === "tool", "工具节点：类型还原为 tool");
  ok(kindOf({ kind: "input_any" }) === "input_any", "文件节点：类型 = kind（转换后就地变化）");
}

console.log("\n[5] i18n 词条（中英）");
{
  has(I18N, '"复制": "Copy"', "「复制」有英文译文");
  has(
    I18N,
    '"复制节点（Ctrl+D）：在选中节点下方复制一个同类节点，仅复制类型、不复制内容"',
    "新按钮标题有词条",
  );
  has(I18N, "Duplicate node (Ctrl+D)", "新按钮标题有英文译文");
  has(I18N, '"请先选中节点": "Select a node first"', "空选中提示有英文译文");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-node-copy-type)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-node-copy-type)\n",
);
process.exit(fails ? 1 : 0);
