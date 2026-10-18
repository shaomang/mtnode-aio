#!/usr/bin/env node
/* test/smoke-port-cut.js — 右键端子切断连线（「经常切不断」）的回归
 * ============================================================================
 * 用户现场：右键点击节点端子的圆点想切断这根线，经常什么都没发生 / 回一句「该端子没有连线」/
 * 切完又被连回来。三处成因（都已在本轮收口）：
 *   ① 端子 mousedown 不分左右键 → 右键一按下就起拖线，松手走 mouseup 的 wire 分支；
 *   ② 连线 SVG 在节点之上、线芯 .fn-edge 带 pointer-events:stroke，终点正压在端子圆心，
 *      瞄圆心那一下点到的是线；端子徽标 pointer-events:none，点字落到节点板上；
 *   ③ 端子号两种写法（`w.toIndex === idx` vs `Number(w.toIndex || 0) === idx`）：旧档里
 *      toIndex 是字符串 / 缺省时，悬停能列出这条线、右键却说没有线。
 *
 * 本脚本验两件事：
 *   [1] 静态口径：唯一真源区块在（app.js PORT-CUT）、逐个端子的旧切断已删、
 *       四处 startWireDrag 入口都有右键判定、捕获阶段一次性绑定、i18n 中英词条齐。
 *   [2] 真函数：把 PORT-CUT 区块与 removeSuperInnerPortWires 抠出来，在沙箱里喂真数据 ——
 *       字符串 / 缺省端子号可切、破洞后左移补位、固定端子不重排、关系线不受伤、
 *       内外侧端子各切各的、几何命中（连线盖住端子 / 离得远不乱切）。
 *
 * 零依赖、不启动 Electron、不碰 %APPDATA%。
 * ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const APP = read("renderer/app.js");
const CANVAS = read("renderer/app-canvas.js");
const I18N = read("renderer/i18n.js");

let fails = 0;
let oks = 0;
function ok(cond, msg) {
  if (cond) {
    oks++;
    console.log("  ok   " + msg);
  } else {
    fails++;
    console.log("  FAIL " + msg);
  }
}
function has(src, needle, msg) {
  ok(src.indexOf(needle) >= 0, msg);
}
function hasnt(src, needle, msg) {
  ok(src.indexOf(needle) < 0, msg);
}
function eqStr(got, want, msg) {
  ok(got === want, msg + "（got=" + JSON.stringify(got) + "）");
}

/* ═════════════════════ [1] 静态口径 ═════════════════════ */
console.log("[1] 唯一真源 / 旧代码已删 / 右键不起拖线 / 词条");

const BEGIN = "/* ===== PORT-CUT-BEGIN";
const END = "/* ===== PORT-CUT-END";
const a0 = APP.indexOf(BEGIN);
const b0 = APP.indexOf(END);
ok(a0 > 0 && b0 > a0, "app.js 有 PORT-CUT 唯一真源区块（本冒烟据此切片）");
const BLOCK = a0 >= 0 && b0 > a0 ? APP.slice(a0, b0) : "";

/* 逐个端子的旧切断（严格比对端子号 + 各自拼文案）必须整体收进一个入口 */
hasnt(
  CANVAS,
  "w.toIndex === idx",
  "app-canvas.js 不再有 `w.toIndex === idx` 这种严格比对（端子号一律 Number 归一）",
);
hasnt(CANVAS, 'I18n.t("已切断输入端子 ")', "输入端子的旧提示拼接已删（走 PORT-CUT 词条）");
hasnt(CANVAS, 'I18n.t("已切断输出端子 ")', "输出端子的旧提示拼接已删（走 PORT-CUT 词条）");
hasnt(CANVAS, 'I18n.t("该输入端子没有连线")', "输入端子不再自己判空（唯一真源在 app.js）");
hasnt(CANVAS, 'I18n.t("该输出端子没有连线")', "输出端子不再自己判空（唯一真源在 app.js）");
has(APP, "function cutPortWires(node, side, idx)", "切断 = 单个函数（cutPortWires）");
has(APP, "function portCutTargetOfEl(el)", "端子身份解析 = 单个函数（portCutTargetOfEl）");
has(APP, "function portCutTargetAt(x, y)", "几何命中 = 单个函数（portCutTargetAt）");
has(APP, "function bindPortWireCut()", "右键入口 = 单个函数（bindPortWireCut）");
has(
  APP,
  "  bindPortWireCut();",
  "bindCanvas 里真的调了 bindPortWireCut()",
);
ok(
  /document\.addEventListener\(\s*"contextmenu",[\s\S]{0,2000}?true,\s*\)/.test(BLOCK),
  "右键入口挂在 document 捕获阶段（端子自己的 contextmenu 一律走到这一处）",
);

/* 右键绝不起拖线：四处端子级 mousedown（输入 / 输出 / 数组槽 / 空槽 + 超级节点桥）都要判键 */
const guards = (CANVAS + APP).match(/if \(ev\.button === 2\)[^\n]*/g) || [];
ok(
  guards.length >= 4,
  "端子 mousedown 各处都有右键判定（找到 " + guards.length + " 处，需 ≥4：输入/输出/数组槽/空槽或桥）",
);
has(
  APP,
  "if (ev && ev.button === 2) return;",
  "startWireDrag 自己再挡一道（入口漏判也不会「一按下右键先起一条线」）",
);
ok(
  !/p\.addEventListener\("mousedown",\s*\(ev\)\s*=>\s*\{\s*ev\.stopPropagation\(\);\s*ev\.preventDefault\(\);\s*hidePortTip\(\);/.test(
    CANVAS,
  ),
  "端子 mousedown 不再「先 preventDefault 再起拖线」（右键那一下不再被吞）",
);

/* 关系线（rel）不许被「切 0 号内侧端子」顺手删掉；端子号归一 */
has(
  APP,
  "if (w.rel) return true;",
  "removeSuperInnerPortWires 跳过关系线（rel 不占端子）",
);
hasnt(
  APP,
  "if (w.to !== superNode.id || Number(w.toIndex) !== idx) return true;",
  "内侧汇端子不再用 Number(w.toIndex) 裸比（缺省 toIndex 会算成 NaN）",
);

/* 断线后画布必须真的少一根线：复用快速通道不拆 DOM，updateWires 得自己回收旧 path */
has(
  CANVAS,
  'svg.querySelectorAll(\'path[id^="wire-"]\')',
  "updateWires 回收「数据里已经没有」的旧连线 path（否则：提示已切断、线还在）",
);
has(
  CANVAS,
  "if (!liveWids.has(wid)) el.remove();",
  "回收按 wire id 集合判（存活集合外的一律移除）",
);

/* 词条：四条完成提示 + 两条内侧空提示都要有英文 */
for (const k of [
  "已切断输入端子 {n} 条连线（Ctrl+Z 可撤销）",
  "已切断输出端子 {n} 条连线（Ctrl+Z 可撤销）",
  "已移除内侧输入端子连线 {n} 条（Ctrl+Z 可撤销）",
  "已移除内侧输出端子连线 {n} 条（Ctrl+Z 可撤销）",
  "该内侧输入端子没有连线",
  "该内侧输出端子没有连线",
]) {
  ok(I18N.indexOf('"' + k + '"') >= 0, "i18n 收了词条：" + k.slice(0, 20) + "…");
}

/* ═════════════════════ [2] 真函数（沙箱） ═════════════════════ */
console.log("\n[2] 真函数：真数据切断");

const RUSTART = APP.indexOf("function removeSuperInnerPortWires(");
const RUEND = APP.indexOf("function moveNodesIntoSuper(", RUSTART);
ok(RUSTART > 0 && RUEND > RUSTART, "能切出 removeSuperInnerPortWires（与线上同一份实现）");
const RU_SRC = RUSTART > 0 ? APP.slice(RUSTART, RUEND) : "";

const PORT_R = 5;

function makeSandbox(opts) {
  opts = opts || {};
  const log = { history: 0, clearDownstream: [], render: 0, save: 0, status: 0, toasts: [] };
  const ports = opts.ports || [];
  const elById = {};
  const doc = {
    querySelectorAll(sel) {
      return sel === "#canvas .port" ? ports : [];
    },
    addEventListener(type, fn, capture) {
      log.listener = { type, fn, capture };
    },
  };
  const canvasStub = { contains: () => true };
  const S = {
    wf: { nodes: opts.nodes || [], wires: opts.wires || [] },
    cam: { x: 0, y: 0, z: 1 },
  };
  const fns = {
    S,
    document: doc,
    PORT_R,
    $: () => canvasStub,
    nodeById: (id) => (S.wf.nodes || []).find((n) => n.id === id) || null,
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    pushHistory: () => {
      log.history++;
    },
    clearDownstream: (id) => {
      log.clearDownstream.push(id);
    },
    wireFromIsControl: (w) => !!w.ctrl,
    hasFixedInPorts: (n) => !!n.fixed,
    isControlKind: (n) => !!n.ctrlish,
    toast: (msg, kind) => {
      log.toasts.push({ msg, kind });
    },
    I18n: {
      t: (k, vars) =>
        String(k).replace(/\{(\w+)\}/g, (m, key) =>
          vars && vars[key] != null ? String(vars[key]) : m,
        ),
    },
    renderCanvas: () => {
      log.render++;
    },
    scheduleSave: () => {
      log.save++;
    },
    renderStatus: () => {
      log.status++;
    },
  };
  const argNames = Object.keys(fns);
  const factory = new Function(
    ...argNames,
    BLOCK +
      "\n" +
      RU_SRC +
      "\nreturn { cutPortWires, cutPortWiresHere, portCutTargetOfEl, portCutTargetAt, bindPortWireCut };",
  );
  const api = factory(...argNames.map((k) => fns[k]));
  return { api, S, log, doc, elById };
}

/* 端子元素桩：classList + dataset + 屏幕矩形 + closest（与 DOM 上「端子元素自己就是 .port」同形） */
function portEl(cls, dataset, cx, cy) {
  const list = String(cls).split(/\s+/).filter(Boolean);
  const el = {
    dataset: dataset || {},
    classList: { contains: (c) => list.indexOf(c) >= 0 },
    closest: (sel) => (sel === ".port" ? el : null),
    getBoundingClientRect: () => ({
      left: cx - 5,
      top: cy - 5,
      width: 10,
      height: 10,
      right: cx + 5,
      bottom: cy + 5,
    }),
  };
  return el;
}

/* ── 2.1 端子身份：四种形态 ── */
{
  const nodes = [
    { id: "a", kind: "proc_text" },
    { id: "s", kind: "super" },
  ];
  const box = makeSandbox({ nodes });
  const t1 = box.api.portCutTargetOfEl(portEl("port in", { node: "a", idx: "2" }));
  eqStr(t1 && t1.side + ":" + t1.idx, "in:2", "输入端子：side=in · idx 取 dataset.idx");
  const t2 = box.api.portCutTargetOfEl(portEl("port out", { node: "a", fromIndex: "3" }));
  eqStr(t2 && t2.side + ":" + t2.idx, "out:3", "输出端子：side=out · idx 取 dataset.fromIndex");
  const t3 = box.api.portCutTargetOfEl(
    portEl("port out super-port super-inner-bridge", { node: "s", fromIndex: "1" }),
  );
  eqStr(t3 && t3.side + ":" + t3.idx, "bridge:1", "超级节点内侧桥端子：side=bridge（先于 .out 判）");
  const t4 = box.api.portCutTargetOfEl(
    portEl("port in super-port super-inner-sink", { node: "s", idx: "0" }),
  );
  eqStr(t4 && t4.side + ":" + t4.idx, "sink:0", "超级节点内侧汇端子：side=sink（先于 .in 判）");
  eqStr(box.api.portCutTargetOfEl(portEl("port in", { node: "nope", idx: "0" })), null, "节点不存在 → null");
  eqStr(box.api.portCutTargetOfEl(null), null, "空元素 → null");
}

/* ── 2.2 输入端子：字符串 toIndex 也要切得掉（旧档 / 外部写入） ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const wires = [{ id: "w1", from: "a", to: "b", fromIndex: 0, toIndex: "1" }];
  const box = makeSandbox({ nodes, wires });
  const n = box.api.cutPortWires(nodes[0], "in", 1);
  eqStr(n, 1, "toIndex 是字符串 \"1\" · 右键 1 号输入端子照样切掉");
  eqStr(box.S.wf.wires.length, 0, "线真的从 S.wf.wires 里没了");
  eqStr(box.log.history, 1, "记了一步撤销");
}

/* ── 2.3 输入端子：toIndex 缺省（旧档）= 0 号 ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const wires = [{ id: "w1", from: "a", to: "b" }];
  const box = makeSandbox({ nodes, wires });
  const n = box.api.cutPortWires(nodes[0], "in", 0);
  eqStr(n, 1, "toIndex 缺省的旧线 · 右键 0 号输入端子切得掉（不再回「没有连线」）");
}

/* ── 2.4 动态端子：切中间一条 → 后面的端子号左移补位 ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const wires = [
    { id: "w0", from: "a", to: "b", fromIndex: 0, toIndex: 0 },
    { id: "w1", from: "c", to: "b", fromIndex: 0, toIndex: 1 },
    { id: "w2", from: "d", to: "b", fromIndex: 0, toIndex: 2 },
  ];
  const box = makeSandbox({ nodes, wires });
  const n = box.api.cutPortWires(nodes[0], "in", 1);
  eqStr(n, 1, "只切这一颗端子上的 1 条");
  eqStr(
    box.S.wf.wires.map((w) => w.id + "@" + w.toIndex).join(","),
    "w0@0,w2@1",
    "后面的线左移补位（端子号保持连续）",
  );
  ok(
    box.S.wf.wires.every((w) => typeof w.toIndex === "number"),
    "补位后写回的是数字（端子号不再是字符串）",
  );
  ok(box.log.clearDownstream.length === 1, "数据线被切 → 清下游缓存");
}

/* ── 2.5 固定端子节点（工具 / 素材 / 交付…）：绝不重排 ── */
{
  const nodes = [{ id: "b", kind: "super", fixed: true }];
  const wires = [
    { id: "w0", from: "a", to: "b", toIndex: 0 },
    { id: "w2", from: "d", to: "b", toIndex: 2 },
  ];
  const box = makeSandbox({ nodes, wires });
  box.api.cutPortWires(nodes[0], "in", 0);
  eqStr(
    box.S.wf.wires.map((w) => w.id + "@" + w.toIndex).join(","),
    "w2@2",
    "固定端子节点：2 号端子上的线不会因为切了 0 号而挪位",
  );
}

/* ── 2.6 控制线不计「数据线」：切控制线不清下游 ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const wires = [{ id: "w0", from: "a", to: "b", toIndex: 0, ctrl: true }];
  const box = makeSandbox({ nodes, wires });
  box.api.cutPortWires(nodes[0], "in", 0);
  eqStr(box.log.clearDownstream.length, 0, "切的是控制线 → 不清下游缓存");
}

/* ── 2.7 关系线不受伤（rel 不占端子） ── */
{
  const nodes = [{ id: "a", kind: "proc_text" }, { id: "b", kind: "proc_text" }];
  const wires = [
    { id: "rel1", from: "a", to: "b", rel: true, fromIndex: 0, toIndex: 0 },
    { id: "w1", from: "a", to: "b", fromIndex: 0, toIndex: 0 },
  ];
  const box = makeSandbox({ nodes, wires });
  box.api.cutPortWires(nodes[1], "in", 0);
  eqStr(box.S.wf.wires.length, 1, "切 0 号输入端子只切数据线，关系线留着");
  eqStr(box.S.wf.wires[0].id, "rel1", "留下的正是那条关系线");
}

/* ── 2.8 输出端子：字符串 fromIndex 也照切 ── */
{
  const nodes = [{ id: "a", kind: "proc_text" }];
  const wires = [{ id: "w1", from: "a", to: "b", fromIndex: "0", toIndex: 0 }];
  const box = makeSandbox({ nodes, wires });
  const n = box.api.cutPortWires(nodes[0], "out", 0);
  eqStr(n, 1, "fromIndex 是字符串 · 输出端子照样切得掉");
  eqStr(box.log.clearDownstream.join(","), "a", "非控制节点切输出线 → 清下游");
}

/* ── 2.9 端口上没有线：返回 0，不动历史 ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const box = makeSandbox({ nodes, wires: [] });
  eqStr(box.api.cutPortWires(nodes[0], "in", 0), 0, "没线 → 返回 0");
  eqStr(box.log.history, 0, "没线 → 不记撤销");
}

/* ── 2.10 超级节点内侧桥 / 汇：各切各的，关系线不在内 ── */
{
  const nodes = [
    { id: "s", kind: "super" },
    { id: "c1", kind: "proc_text", parentSuperId: "s" },
    { id: "c2", kind: "proc_text", parentSuperId: "s" },
    { id: "out", kind: "proc_text" },
  ];
  const wires = [
    { id: "b0", from: "s", to: "c1", fromIndex: 0, toIndex: 0 },
    { id: "b1", from: "s", to: "c2", fromIndex: 1, toIndex: 0 },
    { id: "o0", from: "c1", to: "s", fromIndex: 0, toIndex: 0 },
    { id: "rel1", from: "s", to: "c1", rel: true, fromIndex: 0, toIndex: 0 },
  ];
  const box = makeSandbox({ nodes, wires });
  eqStr(box.api.cutPortWires(nodes[0], "bridge", 0), 1, "内侧桥端子 0 号：只切它那一条");
  eqStr(
    box.S.wf.wires.map((w) => w.id).join(","),
    "b1,o0,rel1",
    "桥 0 号切掉 b0 · 桥 1 号 / 汇线 / 关系线全部原样",
  );
  eqStr(box.api.cutPortWires(nodes[0], "sink", 0), 1, "内侧汇端子 0 号：切掉汇线");
  eqStr(box.S.wf.wires.map((w) => w.id).join(","), "b1,rel1", "汇线没了、关系线还在");
}

/* ── 2.11 几何命中：连线线芯盖住端子也能认出来（离得远不乱切） ── */
{
  const nodes = [{ id: "a", kind: "proc_text" }, { id: "b", kind: "proc_text" }];
  const near = portEl("port in", { node: "b", idx: "0" }, 100, 100);
  const far = portEl("port out", { node: "a", fromIndex: "0" }, 400, 400);
  const box = makeSandbox({ nodes, ports: [near, far] });
  const hit = box.api.portCutTargetAt(104, 101);
  ok(hit && hit.side === "in" && hit.idx === 0, "光标落在端子中心附近 4px → 认作那颗端子（哪怕目标 DOM 是别的）");
  eqStr(box.api.portCutTargetAt(200, 300), null, "离所有端子都远 → 不认（不会误切）");
  ok(box.api.portCutTargetAt(100, 118) === null, "竖向 18px 外 → 不认（不误伤上下相邻端子）");
}

/* ── 2.12 右键入口：捕获阶段一次绑定；端子本体 / 盖住端子的别的东西，都切 ── */
{
  const nodes = [{ id: "b", kind: "proc_text" }];
  const port = portEl("port in", { node: "b", idx: "0" }, 200, 200);
  const wires = [{ id: "w1", from: "a", to: "b", toIndex: 0 }];
  const box = makeSandbox({ nodes, wires, ports: [port] });
  const events = [];
  box.doc.addEventListener = (type, fn, capture) => events.push({ type, fn, capture });
  box.api.bindPortWireCut();
  box.api.bindPortWireCut();
  eqStr(events.length, 1, "bindPortWireCut 幂等（只绑一次）");
  eqStr(events[0].type + "/" + events[0].capture, "contextmenu/true", "绑的是 contextmenu 捕获阶段");

  /* (a) 事件目标就是端子 */
  const evA = {
    target: port,
    clientX: 200,
    clientY: 200,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  events[0].fn(evA);
  ok(evA.prevented && evA.stopped, "点中端子：拦下默认行为并阻止冒泡（不弹节点菜单）");
  eqStr(box.S.wf.wires.length, 0, "点中端子：线被切断");
  eqStr(
    box.log.toasts[box.log.toasts.length - 1].msg,
    "已切断输入端子 1 条连线（Ctrl+Z 可撤销）",
    "提示带条数与 Ctrl+Z",
  );
  ok(box.log.render === 1, "切完重绘一次");

  /* (b) 事件目标不是端子（连线线芯 / 徽标 / 节点板），但光标就在端子上 */
  const wires2 = [{ id: "w2", from: "a", to: "b", toIndex: 0 }];
  box.S.wf.wires = wires2;
  const evB = {
    target: { closest: () => null },
    clientX: 202,
    clientY: 199,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  events[0].fn(evB);
  ok(evB.prevented && evB.stopped, "盖住端子的元素上右键：同样拦下");
  eqStr(box.S.wf.wires.length, 0, "盖住端子的元素上右键：线照样被切断（瞄准圆心就行）");

  /* (c) 离端子很远的地方右键：一律放行 */
  const wires3 = [{ id: "w3", from: "a", to: "b", toIndex: 0 }];
  box.S.wf.wires = wires3;
  const evC = {
    target: { closest: () => null },
    clientX: 700,
    clientY: 700,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  events[0].fn(evC);
  ok(!evC.prevented && !evC.stopped, "远离端子：完全不干预（画布 / 节点的右键菜单照旧）");
  eqStr(box.S.wf.wires.length, 1, "远离端子：线没动");

  /* (d) 数组参数端子的槽点：交给槽点自己按「一条」处理，入口放行 */
  const evD = {
    target: {
      closest: (sel) => (sel === ".fn-arr-slots" ? { className: "fn-arr-slots" } : null),
    },
    clientX: 200,
    clientY: 200,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  events[0].fn(evD);
  ok(!evD.prevented && !evD.stopped, "数组槽点：入口放行，交给槽点自己的「只切这一条」");
  eqStr(box.S.wf.wires.length, 1, "数组槽点：入口不动数据");
}

/* ═════════════════════ 汇总 ═════════════════════ */
console.log("");
if (fails) {
  console.log("✗ smoke-port-cut: " + fails + " 项失败 / " + (fails + oks) + " 项");
  process.exit(1);
}
console.log("✓ smoke-port-cut: " + oks + " 项全绿");
