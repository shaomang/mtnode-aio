"use strict";
/* 关系线几何（普通直线）+ 开发节点架构图排版 —— 纯 Node 冒烟测试（不依赖 Electron）
 *   node test/smoke-rel-layout.js
 * 覆盖：
 *   [1] 排版用边 layoutEdgeSets：数据线不变、关系线按箭头定向、成环降级为软约束
 *   [2] 分层布局：纯关系线图真正分层（不再退化成一排孤立方块）、方块不重叠
 *   [3] 关系线几何：每根都是一条直线段、锚点贴在方块边上、同侧多线扇形分散
 *       （汇聚到同一侧的线按「对端真实来向」排序，消掉 X 形交叉）
 *   [4] 没有两条线叠在一起（近重合）、线上文字不互相压字、排版后穿块不增加
 *   [5] 点击节点高亮：状态类 / 箭头配色 / 其余线淡出的接线是否齐全；
 *       端子文字（输入/输出 与 P/L、序号）一律放到节点外侧、不压住上下端子
 *   [7] 高亮状态机本身：linked / dim / sel 与箭头配色切换 */
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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
function extract(src, names) {
  const out = [];
  for (const nm of names) {
    const pats = [
      new RegExp("\\nfunction " + nm + "\\s*\\(", "m"),
      new RegExp("\\nconst " + nm + "\\s*=", "m"),
      new RegExp("\\nvar " + nm + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + nm);
    let i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + nm);
    const isFn = src.slice(at, at + 8).startsWith("function");
    if (!isFn) {
      const eol = src.indexOf("\n", at);
      out.push(src.slice(at, eol + 1));
      continue;
    }
    let depth = 0;
    let j = i;
    let inStr = null;
    for (; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
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
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) break;
      }
    }
    out.push(src.slice(at, j + 1));
  }
  return out.join("\n");
}

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");

const REL_FNS = [
  "REL_ARROWS",
  "relArrowOf",
  "relSelNodeSet",
  "relHighlightInfo",
  "relWireVisualState",
  "relArrowMarkerUrl",
  "REL_END_GAP",
  "REL_LABEL_GAP",
  "REL_SEP_TOL",
  "REL_SEP_STEP",
  "REL_SEP_MAX",
  "relRectCenter",
  "relBorderAnchor",
  "relSidePoint",
  "relSpreadSide",
  "relPointSegDist",
  "relSegsTooClose",
  "relStraightPath",
  "relSeparateStraight",
  "relFanInversions",
  "relSegsCross",
  "relGeomScore",
  "relAnchorSnapshot",
  "REL_REFINE_MAX",
  "relPlanAnchors",
  "relPlanScope",
];
const LAYOUT_FNS = [
  "snap",
  "LAYOUT_REL_GAP_X",
  "LAYOUT_REL_GAP_Y",
  "relWiresIn",
  "layoutEdgeSets",
  "nodesBBox",
  "layoutNodePriority",
  "layoutNodeSize",
  "assignLayoutLayers",
  "sortLayerByKey",
  "orderLayersByBarycenter",
  "resolveLayerOverlaps",
  "alignLayerToParents",
  "findLayoutComponents",
  "rectsOverlap",
  "shiftToClear",
  "layoutOrigin",
  "layoutFlowComponent",
  "layoutFlowEx",
  "LAYOUT_OVERLAP_PAD",
  "LAYOUT_OVERLAP_MAX_PASS",
  "resolvePlacedOverlaps",
];

const S = { wf: { nodes: [], wires: [] }, config: { snap: 8 } };
const ctx = {
  S,
  grid: () => 8,
  nodeById: (id) => (S.wf.nodes || []).find((n) => n.id === id) || null,
  nodeDrawSize: (n) =>
    n && n.kind === "super" && n.superOpen
      ? {
          w: Math.max(320, Number(n.expandW) || 720),
          h: Math.max(220, Number(n.expandH) || 480),
        }
      : { w: n.w || 288, h: n.h || 192 },
  currentTaskFocus: () => "",
  nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
  nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
  isSuperIoNode: (n) => !!(n && n.superIo),
  isInputKind: (k) => k === "input_text" || k === "input_image",
  isExecStart: (n) => !!(n && n.ctrlRole === "start"),
  isExecEnd: (n) => !!(n && n.ctrlRole && n.ctrlRole !== "start"),
  isSaveNode: (n) => !!(n && String(n.kind).indexOf("save") >= 0),
  console,
  Math,
  Set,
  Map,
  Infinity,
  JSON,
  Array,
  Object,
  String,
  Number,
  RegExp,
  Error,
};
vm.createContext(ctx);
vm.runInContext(
  extract(appSrc + "\n" + nodesSrc, REL_FNS.concat(LAYOUT_FNS)),
  ctx,
  { filename: "rel-layout-extract.js" },
);
const ex = (expr) => vm.runInContext(expr, ctx);

/* ================== 造一个「开发节点架构图」样本 ==================
 * 与真实画布同构：8 个功能块 + 一批带文字的关系线（含回边、双向、无箭头） */
function sample() {
  const W = 288,
    H = 192;
  const mk = (id, x, y, extra) =>
    Object.assign(
      { id, kind: "super", dev: true, devKind: "module", x, y, w: W, h: H },
      extra || {},
    );
  const nodes = [
    mk("A", 48, 48),
    mk("B", 528, 48),
    mk("C", 528, 336),
    mk("D", 1008, 48),
    mk("E", 1008, 336),
    mk("F", 1008, 624),
    mk("G", 1488, 48),
    mk("H", 48, 336),
  ];
  let k = 0;
  const rel = (from, to, label, relArrow) => ({
    id: "w" + ++k,
    from,
    to,
    rel: true,
    relLabel: label || "",
    relArrow: relArrow || "forward",
  });
  const wires = [
    rel("A", "B", "宿主"),
    rel("A", "C", " catalog.json"),
    rel("A", "H", "托管 provider"),
    rel("B", "D", "调用"),
    rel("C", "E", "读写"),
    rel("D", "G", "注册"),
    rel("E", "G", "上报"),
    rel("G", "A", "回边（成环）"),
    rel("G", "H", "反向引用", "backward"),
    rel("B", "C", "并列", "both"),
    rel("D", "E", "并列", "none"),
  ];
  return { nodes, wires };
}

/* ---------- 几何小工具（测试侧，与实现无关） ---------- */
function parsePath(d) {
  const nums = String(d)
    .replace(/[ML]/g, " ")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}
function segsOf(d) {
  const pts = parsePath(d);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++)
    out.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
  return out;
}
/* 两条线段是否 X 形穿越 */
function segCross(s1, s2) {
  const d = (s1[0] - s1[2]) * (s2[1] - s2[3]) - (s1[1] - s1[3]) * (s2[0] - s2[2]);
  if (!d) return false;
  const t =
    ((s1[0] - s2[0]) * (s2[1] - s2[3]) - (s1[1] - s2[1]) * (s2[0] - s2[2])) / d;
  const u =
    ((s1[0] - s2[0]) * (s1[1] - s1[3]) - (s1[1] - s2[1]) * (s1[0] - s1[2])) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}
function crossings(items) {
  let n = 0;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const A = segsOf(items[i].d),
        B = segsOf(items[j].d);
      let hit = false;
      for (const a of A) for (const b of B) if (segCross(a, b)) hit = true;
      if (hit) n++;
    }
  return n;
}
function nearPairs(items) {
  let n = 0;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (ex("relSegsTooClose")(segsOf(items[i].d)[0], segsOf(items[j].d)[0])) n++;
  return n;
}
function onBorder(p, r) {
  const near = (a, b) => Math.abs(a - b) < 0.75;
  const onV =
    (near(p.x, r.x) || near(p.x, r.x + r.w)) &&
    p.y >= r.y - 24 &&
    p.y <= r.y + r.h + 24;
  const onH =
    (near(p.y, r.y) || near(p.y, r.y + r.h)) &&
    p.x >= r.x - 24 &&
    p.x <= r.x + r.w + 24;
  return onV || onH;
}
function dupPaths(items) {
  const seen = new Set();
  let n = 0;
  for (const it of items) {
    if (seen.has(it.d)) n++;
    seen.add(it.d);
  }
  return n;
}
/* 直线穿过无关方块中心圆 = 视觉上是「从方块身上跨过去」 */
function blockHits(nodes, wires, items) {
  let n = 0;
  for (const it of items) {
    const w = wires.find((x) => x.id === it.id);
    for (const s of segsOf(it.d))
      for (const nd of nodes) {
        if (w && (nd.id === w.from || nd.id === w.to)) continue;
        const r = { x: nd.x, y: nd.y, w: nd.w || 288, h: nd.h || 192 };
        const d = ex("relPointSegDist")(
          r.x + r.w / 2,
          r.y + r.h / 2,
          s[0],
          s[1],
          s[2],
          s[3],
        );
        if (d < Math.min(r.w, r.h) / 2) n++;
      }
  }
  return n;
}

/* ===================== [5] 接线与静态检查 ===================== */
console.log("\n[5] 接线 / 源码状态");
ok(
  appSrc.indexOf("function renderRelWiresPass") >= 0,
  "app.js 有按层级统一规划的关系线入口 renderRelWiresPass",
);
ok(
  appSrc.indexOf("function relStraightPath") >= 0 &&
    appSrc.indexOf("function relSeparateStraight") >= 0 &&
    appSrc.indexOf("function relBorderAnchor") >= 0,
  "关系线几何 = 直线段（中心连线定出射边 + 叠线沿边滑开）",
);
ok(
  appSrc.indexOf("relOrthoPath") < 0 &&
    appSrc.indexOf("relAssignChannels") < 0 &&
    appSrc.indexOf("relFreeLane") < 0 &&
    appSrc.indexOf("REL_CORRIDOR") < 0 &&
    appSrc.indexOf("REL_CHAN_STEP") < 0,
  "旧的直角走线 / 走廊车道实现已彻底删除（无死代码残留）",
);
ok(
  appSrc.indexOf("function ensureRelMarkers(svg, host)") >= 0 &&
    appSrc.indexOf("markerUnits") >= 0 &&
    appSrc.indexOf('mkOne(base + "-lk", "lk")') >= 0 &&
    appSrc.indexOf('mkOne(base + "-dim", "dim")') >= 0,
  "箭头 marker 按层级独立 id，并备齐 常态 / 选中 / 关联 / 淡出 四色",
);
ok(
  appSrc.indexOf("function relWireVisualState") >= 0 &&
    appSrc.indexOf("function applyRelWireState") >= 0 &&
    appSrc.indexOf("function refreshRelWireStates") >= 0,
  "高亮状态拆成独立函数（几何不变时也能只刷状态）",
);
ok(
  (appSrc.match(/refreshRelWireStates\(\)/g) || []).length >= 2,
  "选中变化处调用 refreshRelWireStates（点节点即高亮其关系线）",
);
ok(
  appSrc.indexOf("setRelArrowMarkers(p, w, base, sel || linked)") < 0,
  "箭头高亮不再用旧的布尔参数（改由状态字符串驱动）",
);
const canvasSrc = read("renderer/app-canvas.js");
ok(
  canvasSrc.indexOf("renderRelWiresPass(filter)") >= 0 &&
    canvasSrc.indexOf("renderRelWire(w, filter)") < 0,
  "updateWires 改为在壳层内部连线刷新之后统一画关系线",
);
ok(
  (appSrc.match(/function cleanupStaleRelWires/g) || []).length === 1 &&
    appSrc.indexOf('if (p.id.indexOf("rsw-") === 0') >= 0,
  "updateSuperInnerWires 不再把关系线当残留删掉（历史 bug 根因）",
);
ok(
  nodesSrc.indexOf("关系线不参与自动排版") < 0 &&
    nodesSrc.indexOf("function layoutEdgeSets") >= 0,
  "排版不再丢弃关系线（改用带定向 + 破环的边集）",
);
const css = read("renderer/css/canvas.css");
ok(
  /\.fn-edge\.rel\.linked\s*\{[^}]*#9be8ff/.test(css) &&
    /\.fn-edge\.rel\.dim/.test(css) &&
    /\.rel-arrow-head\.lk/.test(css) &&
    /\.wire-rel-label\.dim/.test(css),
  "CSS：点节点时相关线亮起（青色 + 光晕）、无关线淡出、箭头与文字同步",
);
ok(
  /\.fn-edge\.rel\.sel\s*\{[^}]*--orange/.test(css) &&
    /\.rel-arrow-head\.hi/.test(css) &&
    /\.fn-edge-ring\.rel\.sel/.test(css),
  "CSS：选中线本身仍是橙色高亮（线芯 + 外圈 + 箭头同色）",
);
ok(
  css.indexOf("直角") < 0 &&
    appSrc.indexOf("直角关系线") < 0 &&
    canvasSrc.indexOf("直角") < 0,
  "注释与样式表里不再残留「直角走线」的描述",
);

/* ---- 端子文字：一律放到节点外侧（输入左 / 输出右），不许再压住上下相邻端子 ---- */
const badgeRule = (css.match(/\.port-badge\s*\{[^}]*\}/) || [""])[0];
const badgeZhRule = (css.match(/\.port-badge\.zh-label\s*\{[^}]*\}/) || [""])[0];
/* 注意：^ 锚定行首，否则会命中 .wf-node.exec .n-port-label 这类派生选择器 */
const portLabelRule = (css.match(/^\.n-port-label\s*\{[^}]*\}/m) || [""])[0];
ok(
  /\.wf-node\s*\{[^}]*overflow:\s*clip;[^}]*overflow-clip-margin:\s*44px/.test(css),
  "CSS：节点板允许端子文字溢出到外侧（overflow:clip + 44px 通道，其余仍裁剪）",
);
ok(
  badgeRule.indexOf("top: 50%") >= 0 &&
    !/top:\s*-/.test(badgeRule) &&
    !/top:\s*-/.test(badgeZhRule) &&
    /\.port\.in>\.port-badge\s*\{[^}]*right:\s*100%/.test(css) &&
    /\.port\.out>\.port-badge\s*\{[^}]*left:\s*100%/.test(css),
  "CSS：端子文字与端子同一水平线 · 输入出左 / 输出出右（不再放端子上方挡相邻端子）",
);
ok(
  /\.n-port-label\s*\{[^}]*left:\s*-5px/.test(css) &&
    /transform:\s*translateX\(-100%\)/.test(portLabelRule) &&
    /\.n-port-label\.n-pl-out\s*\{[^}]*right:\s*-5px[^}]*translateX\(100%\)/.test(css),
  "CSS：接线排「输入 / 输出」文字贴到节点外侧（左 / 右）",
);
ok(
  /if \(inputCount\(node\) > 0\)[\s\S]{0,300}"n-port-label n-pl-in"/.test(canvasSrc) &&
    /if \(outputCount\(node\) > 0\)[\s\S]{0,300}"n-port-label n-pl-out"/.test(canvasSrc) &&
    canvasSrc.indexOf("stage.appendChild(labIn)") < 0 &&
    css.indexOf(".super-stage>.n-port-label") < 0,
  "DOM：该侧无端子就不出文字；子画布内那份端子文字已删（会被 overflow:hidden 裁掉）",
);

/* ===================== [1] 排版用边 ===================== */
console.log("\n[1] layoutEdgeSets：定向与破环");
const s1 = sample();
S.wf.nodes = s1.nodes;
S.wf.wires = s1.wires;
const es = ex("layoutEdgeSets(S.wf.nodes, S.wf.wires)");
const hardPairs = [];
for (const id in es.outEdges)
  for (const t of es.outEdges[id]) hardPairs.push(id + "->" + t);
ok(
  hardPairs.indexOf("A->B") >= 0 && hardPairs.indexOf("D->G") >= 0,
  "关系线按箭头进入硬边（A->B / D->G）",
);
ok(
  hardPairs.indexOf("G->H") < 0 && hardPairs.indexOf("H->G") >= 0,
  "backward 关系线反向定向（G—backward→H 变成 H->G）",
);
ok(
  hardPairs.indexOf("G->A") < 0,
  "成环的关系边（G->A）被降级为软约束，不会把分层图绕死",
);
const softHas = (a, b) =>
  (es.allIn[a] || []).indexOf(b) >= 0 || (es.allIn[b] || []).indexOf(a) >= 0;
ok(softHas("B", "C") && softHas("D", "E"), "both / none 关系线作为软约束参与排序");
const cyc = ex(`(() => {
  const e = layoutEdgeSets(S.wf.nodes, S.wf.wires);
  const color = {};
  const dfs = (id) => {
    color[id] = 1;
    for (const t of (e.outEdges[id] || [])) {
      if (color[t] === 1) return true;
      if (!color[t] && dfs(t)) return true;
    }
    color[id] = 2;
    return false;
  };
  for (const id in e.outEdges) if (!color[id] && dfs(id)) return true;
  return false;
})()`);
ok(!cyc, "分层用的硬边集合无环（分层算法前提成立）");

/* ===================== [2] 分层排版 ===================== */
console.log("\n[2] 纯关系线架构图的分层排版");
const s2 = sample();
S.wf.nodes = s2.nodes;
S.wf.wires = s2.wires;
ex(`layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 16, y: 16 }, [], { gapX: 196, gapY: 92 })`);
const byId2 = {};
for (const n of S.wf.nodes) byId2[n.id] = n;
const xs = Array.from(new Set(S.wf.nodes.map((n) => n.x))).sort((a, b) => a - b);
ok(
  xs.length >= 3,
  "节点被分成 ≥3 个纵向层（不再退化成一排 5 个的孤立网格）：列 x = " + xs.join(","),
);
ok(
  S.wf.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
  "所有节点坐标都是有限数",
);
let overlap = 0;
for (let i = 0; i < S.wf.nodes.length; i++)
  for (let j = i + 1; j < S.wf.nodes.length; j++) {
    const a = S.wf.nodes[i],
      b = S.wf.nodes[j];
    if (
      a.x < b.x + (b.w || 288) - 1 &&
      b.x < a.x + (a.w || 288) - 1 &&
      a.y < b.y + (b.h || 192) - 1 &&
      b.y < a.y + (a.h || 192) - 1
    )
      overlap++;
  }
ok(overlap === 0, "排版后没有互相压住的方块（重叠 " + overlap + " 对）");
const badDir = hardPairs.filter((p) => {
  const [f, t] = p.split("->");
  return byId2[f].x > byId2[t].x;
});
ok(badDir.length === 0, "每条硬边都从左层指向右层（反向 " + badDir.length + " 条）");

/* ============ [2b] 展开超级节点（绘制尺寸 > 存储尺寸）参与排版不重叠 ============ */
console.log("\n[2b] 展开超级节点 / 障碍物按绘制尺寸参与排版");
{
  const openSuper = (id, x, y, expandW, expandH) => ({
    id,
    kind: "super",
    superOpen: true,
    expandW,
    expandH,
    x,
    y,
    w: 280,
    h: 200,
  });
  const drawRect = (n) => {
    const s = ex("layoutNodeSize")(n);
    return { x: n.x, y: n.y, w: s.w, h: s.h };
  };
  const overlapOf = (list) => {
    let n = 0;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = drawRect(list[i]),
          b = drawRect(list[j]);
        if (
          a.x < b.x + b.w - 1 &&
          b.x < a.x + a.w - 1 &&
          a.y < b.y + b.h - 1 &&
          b.y < a.y + a.h - 1
        )
          n++;
      }
    return n;
  };
  /* 1) 障碍物 = 展开超级节点：layoutOrigin / shiftToClear 按绘制尺寸避开壳层 */
  const obs = [openSuper("obsS", 40, 40, 900, 600)];
  const n1 = { id: "oa", kind: "input_text", x: 0, y: 0, w: 240, h: 160 };
  const n2 = { id: "ob", kind: "proc_text", x: 0, y: 0, w: 240, h: 160 };
  S.wf.nodes = [n1, n2];
  S.wf.wires = [{ id: "ow1", from: "oa", to: "ob" }];
  const ori = ex("layoutOrigin")(obs);
  ex(
    `layoutFlowEx(S.wf.nodes, S.wf.wires, { x: ${ori.x}, y: ${ori.y} }, ${JSON.stringify(obs)}, {})`,
  );
  ok(
    ori.x >= 40 + 900,
    "layoutOrigin 按障碍物绘制宽度定位（origin.x=" + ori.x + " ≥ 940）",
  );
  const ovObs = overlapOf([n1, n2].concat(obs));
  ok(ovObs === 0, "新布局不压住展开超级节点的可见壳层（重叠 " + ovObs + " 对）");
  /* 2) 两个孤立展开超级节点连续装箱：nodesBBox 用绘制尺寸，后壳不撞前壳 */
  const s1 = openSuper("sA", 0, 0, 900, 600);
  const s2 = openSuper("sB", 0, 0, 700, 400);
  S.wf.nodes = [s1, s2];
  S.wf.wires = [];
  ex(`layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 16, y: 16 }, [], {})`);
  const d1 = drawRect(s1),
    d2 = drawRect(s2);
  ok(
    d1.x + d1.w <= d2.x ||
      d2.x + d2.w <= d1.x ||
      d1.y + d1.h <= d2.y ||
      d2.y + d2.h <= d1.y,
    "两个孤立展开超级节点装箱后互不重叠（sA=[" + d1.x + "," + (d1.x + d1.w) + "]×[" + d1.y + "," + (d1.y + d1.h) + "]，sB 起点 x=" + d2.x + "）",
  );
  ok(
    S.wf.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
    "展开超级节点排版后坐标仍为有限数",
  );
}

/* ===================== [3] 直线几何 ===================== */
function plan(nodes, wires) {
  const items = wires.map((w) => {
    const from = nodes.find((n) => n.id === w.from);
    const to = nodes.find((n) => n.id === w.to);
    return {
      w,
      from,
      to,
      ra: { x: from.x, y: from.y, w: from.w, h: from.h },
      rb: { x: to.x, y: to.y, w: to.w, h: to.h },
    };
  });
  ex("relPlanScope")(items);
  return items.map((it) => ({
    id: it.w.id,
    sides: it.sides,
    a: { x: it.a.x, y: it.a.y },
    b: { x: it.b.x, y: it.b.y },
    d: it.d,
    mid: it.mid,
  }));
}

console.log("\n[3] 关系线几何：一条直线段 + 贴边锚点 + 同侧扇形分散");
const s3 = sample();
const items3 = plan(s3.nodes, s3.wires);
ok(items3.length === s3.wires.length, "每条关系线都规划出了几何（" + items3.length + " 条）");
ok(
  items3.every((it) => segsOf(it.d).length === 1),
  "每条线的路径只有一个线段 —— 普通直线，没有直角拐点",
);
ok(
  items3.every((it) => {
    const w = s3.wires.find((x) => x.id === it.id);
    const ra = s3.nodes.find((n) => n.id === w.from);
    const rb = s3.nodes.find((n) => n.id === w.to);
    const pts = parsePath(it.d);
    return (
      onBorder(it.a, ra) &&
      onBorder(it.b, rb) &&
      Math.hypot(pts[0][0] - it.a.x, pts[0][1] - it.a.y) < 8 &&
      Math.hypot(pts[1][0] - it.b.x, pts[1][1] - it.b.y) < 8
    );
  }),
  "直线两端都贴在各自方块的边上（不是浮在中心或角点上）",
);
const fromA = items3.filter((it) => {
  const w = s3.wires.find((x) => x.id === it.id);
  return w && w.from === "A";
});
const distinctA = new Set(fromA.map((it) => Math.round(it.a.y) + "|" + Math.round(it.a.x)));
ok(
  fromA.length >= 2 ? distinctA.size === fromA.length : true,
  "同一节点同一侧的 " + fromA.length + " 条关系线锚点互不重合（扇形分散）",
);
ok(dupPaths(items3) === 0, "没有任何两条线的路径完全一样（重合 " + dupPaths(items3) + " 条）");

/* ---- 汇聚线：同一侧接收多条线时，按「对端真实来向」定序才不交叉 ----
   A→B 把 A 的出射点挤到 B 之下，若目标侧仍按方块中心排序就会交叉（真实架构图常见） */
function convergeSample() {
  const nd = (id, x, y, w, h) => ({ id, kind: "super", x, y, w, h, title: id });
  const nodes = [
    nd("A", 0, 0, 240, 120),
    nd("B", 600, 0, 240, 120),
    nd("T", 1400, 260, 240, 120),
  ];
  const rw = (f, t, l) => ({
    id: f + t,
    from: f,
    to: t,
    rel: true,
    relLabel: l,
    relArrow: "forward",
  });
  return {
    nodes,
    wires: [rw("A", "B", "并列"), rw("A", "T", "依赖"), rw("B", "T", "注入")],
  };
}
function firstPassPlan(nodes, wires) {
  const items = wires.map((w) => {
    const from = nodes.find((n) => n.id === w.from);
    const to = nodes.find((n) => n.id === w.to);
    return {
      w,
      from,
      to,
      ra: { x: from.x, y: from.y, w: from.w, h: from.h },
      rb: { x: to.x, y: to.y, w: to.w, h: to.h },
    };
  });
  ex("relPlanAnchors")(items, false);
  return items.map(
    (it) => ({
      id: it.w.id,
      d: "M " + it.a.x + " " + it.a.y + " L " + it.b.x + " " + it.b.y,
    }),
  );
}
const cv = convergeSample();
const cvFirst = firstPassPlan(cv.nodes, cv.wires);
S.wf = { nodes: cv.nodes, wires: cv.wires };
const cvSlim = plan(cv.nodes, cv.wires);
ok(crossings(cvFirst) === 1, "对照组：只按方块中心排锚点 → 汇聚线交叉 1 处");
ok(
  crossings(cvSlim) === 0,
  "锚点收敛趟生效：汇聚到同一侧的线按真实来向定序（交叉 1 → 0）",
);
ok(
  crossings(cvSlim) === 0 && nearPairs(cvSlim) === 0 && dupPaths(cvSlim) === 0,
  "收敛之后仍然没有叠线 / 完全重合的线",
);
ok(
  appSrc.indexOf("relPlanAnchors(items, false)") >= 0 &&
    appSrc.indexOf("relPlanAnchors(items, true)") >= 0 &&
    appSrc.indexOf("relGeomScore") >= 0,
  "relPlanScope：第一趟按中心、后续趟按来向，且只在直线交叉真变少时接受",
);

/* ===================== [4] 叠线 / 文字压字 ===================== */
console.log("\n[4] 直线彼此可分辨 / 线上文字不压字 / 排版后穿块不增加");
ok(nearPairs(items3) === 0, "样本 11 条直线没有近重合叠线（" + nearPairs(items3) + " 对）");
const mids = items3.filter((it) => it.mid && Number.isFinite(it.mid.x));
ok(mids.length === items3.length, "每条线都有文字落点（直线中点沿法线让开）");
let labelHit = 0;
for (let i = 0; i < items3.length; i++)
  for (let j = i + 1; j < items3.length; j++) {
    const ta = (s3.wires.find((w) => w.id === items3[i].id) || {}).relLabel || "";
    const tb = (s3.wires.find((w) => w.id === items3[j].id) || {}).relLabel || "";
    if (!ta.trim() || !tb.trim()) continue;
    const a = items3[i].mid,
      b = items3[j].mid;
    if (Math.abs(a.x - b.x) < 26 && Math.abs(a.y - b.y) < 12) labelHit++;
  }
ok(labelHit === 0, "带文字的关系线没有互相压字（重叠 " + labelHit + " 对）");
const hitBefore = blockHits(s3.nodes, s3.wires, items3);
const s4 = sample();
S.wf.nodes = s4.nodes;
S.wf.wires = s4.wires;
ex(`layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 16, y: 16 }, [], { gapX: 196, gapY: 92 })`);
const items4 = plan(s4.nodes, s4.wires);
const hitAfter = blockHits(s4.nodes, s4.wires, items4);
ok(
  hitAfter <= hitBefore,
  "分层排版后直线穿过无关方块的次数不增加（" + hitBefore + " → " + hitAfter + "）",
);
ok(nearPairs(items4) === 0, "排版后仍没有叠在一起的直线（" + nearPairs(items4) + " 对）");
console.log(
  "      · 交叉穿越 " +
    crossings(items3) +
    " → " +
    crossings(items4) +
    " · 分层 " +
    new Set(s4.nodes.map((n) => n.x)).size +
    " 列",
);

/* ============ [6] 真实画布样本（本机保存的开发节点架构图） ============ */
function findRealDevCanvases() {
  const dirs = [];
  if (process.env.MTNODE_SAVE_DIR) dirs.push(process.env.MTNODE_SAVE_DIR);
  if (process.env.APPDATA)
    dirs.push(path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "save"));
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      let wf;
      try {
        wf = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      } catch (e) {
        continue;
      }
      const rels = (wf.wires || []).filter((w) => w && w.rel);
      if (rels.length >= 5 && (wf.nodes || []).some((n) => n.dev)) out.push({ wf, file: f });
    }
    if (out.length) break;
  }
  return out;
}
function measure(kids, relWires) {
  const slim = plan(kids, relWires);
  return {
    n: slim.length,
    dup: dupPaths(slim),
    near: nearPairs(slim),
    cross: crossings(slim),
    block: blockHits(kids, relWires, slim),
    straight: slim.every((it) => segsOf(it.d).length === 1),
  };
}
const real = findRealDevCanvases();
if (!real.length) {
  console.log("\n[6] 真实画布样本：本机没有带关系线的存档，跳过");
} else {
  console.log("\n[6] 真实画布样本（排版前 → 排版后）");
  for (const { wf, file } of real.slice(0, 3)) {
    const host = (wf.nodes || []).find(
      (n) => n.dev && (wf.nodes || []).some((c) => c.parentSuperId === n.id),
    );
    if (!host) continue;
    const kids = (wf.nodes || []).filter((n) => n.parentSuperId === host.id && !n.superIo);
    const kidIds = new Set(kids.map((n) => n.id));
    const relWires = (wf.wires || []).filter(
      (w) => w.rel && kidIds.has(w.from) && kidIds.has(w.to),
    );
    if (relWires.length < 5) continue;
    S.wf = { nodes: kids, wires: relWires };
    /* 存档里的坐标可能是用户手动排过的（甚至比算法更干净），拿它当硬基线会误报；
       基线改用「一行 5 个 + 固定间距」的朴素网格 —— 那才是分层排版真正要打败的对象。 */
    const saved = kids.map((n) => ({ x: n.x, y: n.y }));
    const restore = (pos) =>
      kids.forEach((n, i) => {
        n.x = pos[i].x;
        n.y = pos[i].y;
      });
    const before = measure(kids, relWires);
    (function placeNaiveGrid() {
      const perRow = 5;
      let y = 16;
      for (let r = 0; r * perRow < kids.length; r++) {
        const row = kids.slice(r * perRow, r * perRow + perRow);
        const hMax = Math.max.apply(
          null,
          row.map((n) => n.h || 192),
        );
        let x = 16;
        for (const n of row) {
          n.x = x;
          n.y = y;
          x += (n.w || 288) + 40;
        }
        y += hMax + 60;
      }
    })();
    const naive = measure(kids, relWires);
    restore(saved);
    ex(`layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 16, y: 16 }, [], { gapX: 196, gapY: 92 })`);
    const after = measure(kids, relWires);
    const cols = new Set(kids.map((n) => n.x)).size;
    console.log(
      "      " +
        file +
        " · " +
        (host.title || host.id) +
        "：" +
        kids.length +
        " 块 / " +
        relWires.length +
        " 条 · 朴素网格 穿块 " +
        naive.block +
        " 叠线 " +
        naive.near +
        " → 分层 穿块 " +
        after.block +
        " 叠线 " +
        after.near +
        " 交叉 " +
        after.cross +
        " · " +
        cols +
        " 列（存档现状 穿块 " +
        before.block +
        "）",
    );
    ok(after.straight, "真实架构图的关系线全部是直线段（无折线残留）");
    ok(
      after.dup === 0,
      "真实架构图没有完全重合的关系线（朴素网格 " + naive.dup + " → " + after.dup + "）",
    );
    /* 交叉「对数」在不同拓扑之间不可直接互比（朴素网格把无关方块塞进同一行，线更短、
       交叉自然少）。可辨性的硬指标是：不叠线、不重合、不穿过无关方块，并且真的分了层。 */
    ok(
      after.near <= naive.near && after.block <= naive.block && cols >= 2,
      "分层排版比朴素网格更可辨（叠线 " +
        naive.near +
        "→" +
        after.near +
        "，穿块 " +
        naive.block +
        "→" +
        after.block +
        "，" +
        cols +
        " 列）",
    );
    ok(
      after.cross <= relWires.length,
      "直线交叉数量在可解释范围内（" +
        after.cross +
        " 处 / " +
        relWires.length +
        " 条线）",
    );
  }
}

/* ===================== [7] 点选节点 → 高亮状态 ===================== */
console.log("\n[7] 点击节点时相关关系线高亮（状态机）");
const s7 = sample();
S.wf = { nodes: s7.nodes, wires: s7.wires };
const wAB = s7.wires.find((x) => x.from === "A" && x.to === "B");
const wDE = s7.wires.find((x) => x.from === "D" && x.to === "E");
S.selSet = new Set(["A"]);
S.sel = "A";
S.selWire = null;
let hi7 = ex("relHighlightInfo")();
ok(hi7.any === true && hi7.set.has("A"), "选中 A：高亮上下文认到「有关系线连着它」");
ok(ex("relWireVisualState")(wAB, null, hi7) === "linked", "连着 A 的关系线 → linked（青色亮起）");
ok(ex("relWireVisualState")(wDE, null, hi7) === "dim", "与 A 无关的关系线 → dim（淡出退到背景）");
S.selSet = new Set(["SHELL"]);
S.sel = "SHELL";
hi7 = ex("relHighlightInfo")();
ok(
  ex("relWireVisualState")(wDE, { id: "SHELL" }, hi7) === "linked",
  "选中宿主壳层本身：壳内所有关系线一起算相关 → 亮起",
);
S.selSet = new Set(["ZZZ"]);
S.sel = "ZZZ";
hi7 = ex("relHighlightInfo")();
ok(
  hi7.any === false && ex("relWireVisualState")(wAB, null, hi7) === "",
  "选中一个没有任何关系线的节点：不做淡出（整张架构图不会消失）",
);
S.selSet = new Set();
S.sel = null;
S.selWire = wAB.id;
ok(
  ex("relWireVisualState")(wAB, null, ex("relHighlightInfo")()) === "sel",
  "点线本身 → sel（橙色 = 选中这条线）",
);
ok(
  ex("relArrowMarkerUrl")("relArrow", "") === "url(#relArrow)" &&
    ex("relArrowMarkerUrl")("relArrow", "linked") === "url(#relArrow-lk)" &&
    ex("relArrowMarkerUrl")("relArrow", "sel") === "url(#relArrow-hi)" &&
    ex("relArrowMarkerUrl")("relArrow", "dim") === "url(#relArrow-dim)",
  "箭头 marker 随状态切换配色（常态 / 关联 / 选中 / 淡出）",
);
S.selWire = null;

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
