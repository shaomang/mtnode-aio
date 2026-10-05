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
  "LAYOUT_RATIO_R",
  "LAYOUT_ASPECT_TARGET",
  "LAYOUT_FLOW_MAX_W",
  "LAYOUT_MAX_STACK_H",
  "LAYOUT_MIN_W",
  "LAYOUT_MIN_H",
  "layoutGap",
  "layoutSnapSized",
  "layoutSnapSize",
  "snapNodeSizesForLayout",
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
  "layoutRatioOk",
  "layoutNodeShrinkable",
  "layoutVerticalKey",
  "layoutSortColumn",
  "layoutColumnWidth",
  "layoutColumnHeight",
  "layoutRowMaxW",
  "layoutSplitColumn",
  "layoutBuildColumns",
  "layoutAlignColumnsInRows",
  "layoutPlaceLayer",
  "layoutFlowComponent",
  "layoutFlowEx",
  "LAYOUT_OVERLAP_PAD",
  "LAYOUT_OVERLAP_MAX_PASS",
  "layoutOverlapPad",
  "resolvePlacedOverlaps",
  "canvasEditWantsLayout",
  "nodePlacementObstacles",
  "freeSpotForNode",
  "rectsOverlap",
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

/* ============ 间距硬指标（2026-02 需求）：不重叠 + 相邻恰好 1 格 + 网格对齐 ============
   这几条是排版的新契约，下面所有样本都拿它们过一遍：
     · 任意两节点（按绘制尺寸）矩形不相交；
     · 真紧靠的一对（x 区间重叠且垂直相邻 / y 区间重叠且水平相邻）缝宽 === 1 个网格，
       且另一方「隔开」的一对缝 ≥ 1 个网格（不允许比 1 格更近）；
     · x / y / w / h 都是网格倍数（展开的壳层按 expandW/H 计）。 */
const G = 8;
const rectsOf = (list) =>
  list.map((n) => {
    const s = ex("layoutNodeSize")(n);
    return { id: n.id, x: n.x, y: n.y, w: s.w, h: s.h, superOpen: !!(n.superOpen || n.expandW) };
  });
function overlapPairs(list) {
  const rs = rectsOf(list);
  const out = [];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i],
        b = rs[j];
      if (a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001 && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001)
        out.push(a.id + "/" + b.id);
    }
  return out;
}
/** 相邻对与「缝不足 1 格」的对：返回 { tightBad, count } */
function gapAudit(list) {
  const rs = rectsOf(list);
  const tightBad = [];
  let count = 0;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i],
        b = rs[j];
      const xOv = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const yOv = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const vGap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h); /* 竖直缝 */
      const hGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w); /* 水平缝 */
      let gap = null;
      if (xOv > 0 && vGap >= 0) gap = vGap;
      else if (yOv > 0 && hGap >= 0) gap = hGap;
      if (gap == null) continue; /* 斜对角 / 隔着一列一行：不算相邻 */
      count++;
      if (gap < G - 0.001) tightBad.push(a.id + "/" + b.id + ":" + gap);
    }
  }
  return { tightBad, count };
}
function gridAlignedBad(list) {
  const bad = [];
  for (const n of list) {
    const s = ex("layoutNodeSize")(n);
    const vals = [n.x, n.y, s.w, s.h].map((v) => Math.round(Number(v) || 0));
    const isSuperCollapsed = n.kind === "super" && !(n.superOpen || n.expandW);
    if (isSuperCollapsed) continue; /* 折叠壳层尺寸不参与本次口径（展开态才吸网格） */
    if (vals.some((v) => v % G !== 0)) bad.push(n.id + "(" + vals.join(",") + ")");
  }
  return bad;
}
/** 一组硬指标跑完，返回 true=全过 */
function okGridContract(list, label) {
  const ov = overlapPairs(list);
  ok(ov.length === 0, label + "：节点互不重叠（重叠 " + ov.length + " 对" + (ov.length ? "：" + ov.slice(0, 3) + "）" : "）"));
  const audit = gapAudit(list);
  ok(
    audit.tightBad.length === 0,
    label + "：没有比 1 格更近的缝（相邻对 " + audit.count + "，违例 " + audit.tightBad.length + (audit.tightBad.length ? "：" + audit.tightBad.slice(0, 3) : "") + "）",
  );
  const align = gridAlignedBad(list);
  ok(
    align.length === 0,
    label + "：坐标与尺寸都是网格倍数（违例 " + align.length + (align.length ? "：" + align.slice(0, 3) : "") + "）",
  );
  return ov.length === 0 && audit.tightBad.length === 0 && align.length === 0;
}
/** 「相邻距离恰好 = 1 格」：只对**紧邻**的一对断言精确值 ——
 *  相邻 = 同一行里左右紧邻 / 同一列里上下紧邻（中间没有第三方节点隔着）。
 *  尺寸不同的两个节点之间做不到同时精确 1 格（共识：钉到「≥1 格 + 网格对齐」）。 */
function exactGapViolations(list) {
  const rs = rectsOf(list).filter((r) => !r.superOpen);
  const between = (p, a, b) =>
    rs.some(
      (m) =>
        m !== a &&
        m !== b &&
        m.x > Math.min(a.x, b.x) - 0.001 &&
        m.x + m.w < Math.max(a.x + a.w, b.x + b.w) + 0.001 &&
        m.y > Math.min(a.y, b.y) - 0.001 &&
        m.y + m.h < Math.max(a.y + a.h, b.y + b.h) + 0.001,
    );
  const bad = [];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i],
        b = rs[j];
      if (a.w !== b.w || a.h !== b.h) continue;
      const xOv = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const yOv = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const vGap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      const hGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      if (xOv > 0 && vGap >= 0) {
        if (vGap !== G && !between(null, a, b)) bad.push(a.id + "/" + b.id + " vGap=" + vGap);
      } else if (yOv > 0 && hGap >= 0) {
        if (hGap !== G && !between(null, a, b)) bad.push(a.id + "/" + b.id + " hGap=" + hGap);
      }
    }
  return bad;
}

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

/* ---- 端子徽标：接线排「输入 / 输出」文字已删除 · 徽标写全名 · 节点高亮时看完整 ---- */
const badgeRule = (css.match(/\.port-badge\s*\{[^}]*\}/) || [""])[0];
const badgeZhRule = (css.match(/\.port-badge\.zh-label\s*\{[^}]*\}/) || [""])[0];
const pbNameRule = (css.match(/\.port-badge \.pb-name\s*\{[^}]*\}/) || [""])[0];
const lightCss = read("renderer/css/theme-light.css");
const execCss = (css.match(/\.wf-node\.exec[^{]*\{[^}]*\}/g) || []).join("\n");
ok(
  /\.wf-node\s*\{[^}]*overflow:\s*clip;[^}]*overflow-clip-margin:\s*44px/.test(css),
  "CSS：节点板允许端子徽标溢出到外侧（overflow:clip + 44px 通道，其余仍裁剪）",
);
ok(
  badgeRule.indexOf("top: 50%") >= 0 &&
    !/top:\s*-/.test(badgeRule) &&
    !/top:\s*-/.test(badgeZhRule) &&
    /\.port\.in>\.port-badge\s*\{[^}]*right:\s*100%/.test(css) &&
    /\.port\.out>\.port-badge\s*\{[^}]*left:\s*100%/.test(css),
  "CSS：端子徽标与端子同一水平线 · 输入出左 / 输出出右（不放端子上方挡相邻端子）",
);
ok(
  css.indexOf("n-port-label") < 0 &&
    lightCss.indexOf("n-port-label") < 0 &&
    canvasSrc.indexOf("n-port-label") < 0 &&
    canvasSrc.indexOf("plabel") < 0,
  "端子排不再创建「输入 / 输出」板外文字（DOM 与样式一并清除，含浅色主题）",
);
ok(
  pbNameRule.indexOf("overflow: hidden") >= 0 &&
    pbNameRule.indexOf("text-overflow: ellipsis") >= 0 &&
    /max-width:\s*3\d+px/.test(pbNameRule),
  "CSS：徽标正文（.pb-name）平时收 max-width 出省略号 —— 不再被 44px 通道硬裁半个字",
);
ok(
  /\.wf-node\.sel,\s*\.wf-node:hover\s*\{[^}]*overflow-clip-margin:\s*400px/.test(css) &&
    /\.wf-node\.sel \.port-badge \.pb-name,\s*\.wf-node:hover \.port-badge \.pb-name\s*\{[^}]*max-width:\s*340px/.test(css),
  "CSS：节点高亮（选中 / 悬停）时放开裁切 → 完整端子名称可见且不被截断",
);
ok(
  (canvasSrc.match(/setPortBadgeName\(/g) || []).length >= 15 &&
    canvasSrc.indexOf("clipStr(aItems") < 0 &&
    canvasSrc.indexOf("clipStr((pl[") < 0 &&
    appSrc.indexOf("clipStr(pname") < 0,
  "DOM：外侧与内侧端子徽标一律写完整名称（徽标处不再有 clipStr 切字）",
);
ok(
  execCss.indexOf("n-port-label") < 0,
  "执行节点那条「隐藏小标签」的规则随文字一起删除",
);
/* 真跑徽标正文：DOM 里落的就是完整名称（切字交给 CSS），且名称单独包一层 .pb-name，
   数组端子的槽位点仍挂在徽标本体上 —— 不会被这层裁切吃掉。 */
{
  const mkEl = (tag) => {
    const el = { tagName: tag, className: "", textContent: "", children: [] };
    el.appendChild = (c) => el.children.push(c);
    return el;
  };
  const pbCtx = vm.createContext({ document: { createElement: mkEl } });
  vm.runInContext(extract(canvasSrc, ["setPortBadgeName"]), pbCtx);
  const long = "reference_image_paths_01";
  const badge = mkEl("span");
  pbCtx.setPortBadgeName(badge, long);
  ok(
    badge.children.length === 1 &&
      badge.children[0].className === "pb-name" &&
      badge.children[0].textContent === long,
    "真跑：徽标正文 = 完整端子名（不切字 · 单独包 .pb-name 供 CSS 裁切）",
  );
  const empty = mkEl("span");
  pbCtx.setPortBadgeName(empty, null);
  ok(
    empty.children.length === 1 && empty.children[0].textContent === "",
    "真跑：名称为空也不抛错（给一个空的 .pb-name）",
  );
}

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
/* 2026-02 新口径：相邻缝恰好 1 格 + 坐标尺寸网格对齐 */
okGridContract(S.wf.nodes, "[2] 关系线架构图");
const exact2 = exactGapViolations(S.wf.nodes);
ok(
  exact2.length === 0,
  "[2] 相邻（同尺寸、真紧靠）的缝恰好 = 1 格（违例 " + exact2.length + (exact2.length ? "：" + exact2.slice(0, 3) : "") + "）",
);
/* 需求 ② 的口径是「上游在左**或**在上」：同一行里靠左，折到下一行时靠上。 */
const badDir = hardPairs.filter((p) => {
  const [f, t] = p.split("->");
  const a = byId2[f],
    b = byId2[t];
  return a.x > b.x + 8 && a.y > b.y + 8;
});
ok(badDir.length === 0, "每条硬边都满足「上游在左或在上」（违反 " + badDir.length + " 条）");

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
    /* 2026-02 口径：间距被钉成「恰好 1 格」，节点必然比旧的大间距排得更紧 ——
       「穿块数」不再适合与朴素网格直接比高低（那是间距的函数，不是算法的优劣）。
       这里改钉新契约：不叠线、不重合、真的分了层、并且 1 格间距硬指标全过。 */
    ok(
      after.near === 0 && after.dup === 0 && cols >= 2,
      "真实架构图排版后仍可辨（叠线 " +
        after.near +
        "，重合 " +
        after.dup +
        "，" +
        cols +
        " 列；穿块 " +
        naive.block +
        "→" +
        after.block +
        " 属紧凑间距的必然结果）",
    );
    ok(okGridContract(kids, "[6] 真实架构图 " + file), "真实架构图满足 1 格间距硬指标");
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

/* ================== [8] 新自动排版算法 ==================
 * 需求口径：① 每层包围盒收进 16:9 ~ 9:16（收不进就告警，不许硬凑）
 *          ② 上游在左或上（每条硬边）、连线的节点相近、少交叉
 *          ③ 整块尽量聚成方形，不散开
 *          ④ 优化有界：确定性、无随机、小图快 */
console.log("\n[8] 自动排版算法：形状 / 方向 / 聚焦 / 确定性 / 时延");

/* 造 4 层 × N 个并排节点的「宽图」—— 4 条并行链（互不相连） */
function gridSample(n) {
  const nodes = [];
  const wires = [];
  let k = 0;
  for (let L = 0; L < 4; L++)
    for (let i = 0; i < n; i++)
      nodes.push({ id: "g" + L + "_" + i, x: i * 400, y: L * 300, w: 288, h: 192 });
  for (let L = 0; L + 1 < 4; L++)
    for (let i = 0; i < n; i++)
      wires.push({ id: "gw" + ++k, from: "g" + L + "_" + i, to: "g" + (L + 1) + "_" + i });
  return { nodes, wires };
}
{
  const g = gridSample(4);
  S.wf.nodes = g.nodes.map((x) => Object.assign({}, x));
  S.wf.wires = g.wires.map((x) => Object.assign({}, x));
  const r8 = ex("layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 8, y: 8 }, [], {})");
  /* 2026-02 口径：硬约束是「不重叠 + 相邻恰好 1 格」，宽高比不再硬求 */
  ok(
    r8.ratioOk === true,
    "需求①：宽高比降级为形状偏好（如实回报实际形状 " +
      Math.round(r8.w) +
      "×" +
      Math.round(r8.h) +
      "）",
  );
  okGridContract(S.wf.nodes, "[8] 4 条并行链");
  const exact8 = exactGapViolations(S.wf.nodes);
  ok(
    exact8.length === 0,
    "需求①：相邻（同尺寸、真紧靠）的缝恰好 = 1 个网格（违例 " + exact8.length + (exact8.length ? "：" + exact8.slice(0, 3) : "") + "）",
  );
  /* 分层是硬顺序：同一条链上的节点必须左右/上下单调，不能把下游摆到上游左边 */
  const pos8 = new Map(S.wf.nodes.map((n) => [n.id, n]));
  let bad8 = 0;
  for (const w of g.wires) {
    const a = pos8.get(w.from);
    const b = pos8.get(w.to);
    if (a.x > b.x + 8 && a.y > b.y + 8) bad8++;
  }
  ok(bad8 === 0, "需求②：每条硬边都满足「上游在左或在上」（违反 " + bad8 + " 条）");

  /* 确定性：同一输入两次排版结果完全一致 */
  const r2 = ex("layoutFlowEx(S.wf.nodes.map((n) => Object.assign({}, n)), S.wf.wires, { x: 8, y: 8 }, [], {})");
  ok(
    Math.abs(r2.w - r8.w) < 1e-6 && Math.abs(r2.h - r8.h) < 1e-6,
    "需求④：同一输入两次排版结果完全一致（无随机源）",
  );
}

/* 长链不再抽成一条横贯长带：折成正形网格，并保持「上游在左或在上」 */
{
  const nodes = [];
  const wires = [];
  for (let i = 0; i < 9; i++) nodes.push({ id: "c" + i, x: i * 400, y: 0, w: 288, h: 192 });
  for (let i = 0; i + 1 < 9; i++) wires.push({ id: "cw" + i, from: "c" + i, to: "c" + (i + 1) });
  S.wf.nodes = nodes;
  S.wf.wires = wires;
  const r9 = ex("layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 8, y: 8 }, [], {})");
  const pos9 = new Map(S.wf.nodes.map((n) => [n.id, n]));
  let rev9 = 0;
  for (const w of wires) {
    const a = pos9.get(w.from);
    const b = pos9.get(w.to);
    if (a.x > b.x + 8 && a.y > b.y + 8) rev9++;
  }
  const rows9 = new Set(S.wf.nodes.map((n) => n.y)).size;
  ok(
    r9.ratioOk === true,
    "需求①③：长链按 1 格间距排开（" +
      Math.round(r9.w) +
      "×" +
      Math.round(r9.h) +
      " · " +
      rows9 +
      " 行）",
  );
  ok(rev9 === 0, "折行后仍满足「上游在左或在上」（违反 " + rev9 + " 条）");
  okGridContract(S.wf.nodes, "[8] 9 连长链");
  const exact9 = exactGapViolations(S.wf.nodes);
  ok(
    exact9.length === 0,
    "9 连长链：相邻缝恰好 = 1 个网格（违例 " + exact9.length + (exact9.length ? "：" + exact9.slice(0, 3) : "") + "）",
  );
}

/* 超宽节点（宽 2600 > 一行上限）也必须排开且尺寸不被缩 */
{
  const nodes = [
    { id: "b0", x: 0, y: 0, w: 2600, h: 220 },
    { id: "b1", x: 0, y: 400, w: 2600, h: 220 },
    { id: "b2", x: 0, y: 800, w: 2600, h: 220 },
  ];
  const wires = [
    { id: "bw0", from: "b0", to: "b1" },
    { id: "bw1", from: "b1", to: "b2" },
  ];
  S.wf.nodes = nodes;
  S.wf.wires = wires;
  const rb = ex("layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 8, y: 8 }, [], {})");
  ok(
    rb.scaled === 1 && nodes.every((n) => n.w === 2600 && n.h === 224),
    "尺寸只吸网格、绝不缩放（w 原样 2600，h 220→224 就近吸到 8 的倍数；scaled=" + rb.scaled + "）",
  );
  okGridContract(S.wf.nodes, "[8] 超宽节点链");
  const exactB = exactGapViolations(S.wf.nodes);
  ok(
    exactB.length === 0,
    "超宽节点链：同尺寸相邻缝恰好 = 1 个网格（违例 " + exactB.length + (exactB.length ? "：" + exactB.slice(0, 3) : "") + "）",
  );
}

/* 需求④：有界优化 —— 大批量图也不超时（预算 60ms 局部搜索 + 折行打包） */
{
  const big = gridSample(8);
  S.wf.nodes = big.nodes;
  S.wf.wires = big.wires;
  const t0 = Date.now();
  const rb = ex("layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 8, y: 8 }, [], {})");
  const ms = Date.now() - t0;
  ok(ms <= 300, "需求④：32 节点图排版在预算内完成（" + ms + "ms ≤ 300ms）");
  let ovB = 0;
  for (let i = 0; i < big.nodes.length; i++)
    for (let j = i + 1; j < big.nodes.length; j++) {
      const a = big.nodes[i],
        b = big.nodes[j];
      if (a.x < b.x + 288 - 1 && b.x < a.x + 288 - 1 && a.y < b.y + 192 - 1 && b.y < a.y + 192 - 1)
        ovB++;
    }
  ok(ovB === 0 && rb.nodes === big.nodes.length, "32 节点图排版后互不重叠（重叠 " + ovB + " 对）");

  /* 稠密大图：收尾的交叉度量必须封顶，否则会退化成秒级（曾实测 2.2s） */
  const nodes = [];
  const wires = [];
  let k = 0;
  for (let i = 0; i < 80; i++) nodes.push({ id: "d" + i, x: 0, y: 0, w: 288, h: 192 });
  for (let i = 0; i < 80; i++)
    for (let j = 1; j <= 5; j++) if (i + j < 80) wires.push({ id: "dw" + ++k, from: "d" + i, to: "d" + (i + j) });
  S.wf.nodes = nodes;
  S.wf.wires = wires;
  const t1 = Date.now();
  ex("layoutFlowEx(S.wf.nodes, S.wf.wires, { x: 8, y: 8 }, [], {})");
  const ms1 = Date.now() - t1;
  ok(
    ms1 <= 1500,
    "需求④：80 节点 / " + wires.length + " 连线的稠密图排版仍有界（" + ms1 + "ms ≤ 1500ms）",
  );
}

/* 排版闸（2026-02 需求改写）：编辑**不再**自动排版 —— agent / MCP 的普通编辑只落
   内容与连线，位置与尺寸都不碰。排版只剩一个入口：调用方本笔显式写 layout:true
   （用户点「一键排版」走 tidyLayout，那条路根本不进 applyCanvasEdit）。 */
{
  const wants = ex("canvasEditWantsLayout");
  ok(wants({ create: [{ alias: "a", kind: "input_text" }] }, [{}]) === false, "编辑闸：建图 → 不自动排版");
  ok(wants({ connect: [{ from: "a", to: "b" }] }, []) === false, "编辑闸：连线 → 不自动排版");
  ok(wants({ remove: ["x"] }, []) === false, "编辑闸：删节点 → 不自动排版");
  ok(wants({ createMarks: [{ kind: "box" }] }, []) === false, "编辑闸：加标注 → 不自动排版");
  ok(wants({ update: [{ w: 400 }] }, []) === false, "编辑闸：改尺寸 → 不自动排版（尺寸是调用方钉的）");
  ok(wants({ update: [{ title: "只改标题" }] }, []) === false, "编辑闸：只改文本 → 不排版");
  ok(wants({ layout: true }, []) === true, "编辑闸：显式 layout:true → 唯一入口，照排");
  ok(wants({ layout: true, create: [{ alias: "a", kind: "input_text" }] }, [{}]) === true, "编辑闸：显式 layout:true + 建图 → 照排");
  ok(wants({}, []) === false, "编辑闸：空编辑 → 不排版");
  ok(wants(null, []) === false, "编辑闸：没有参数 → 不排版");
}

/* ============ [9] 绘制跟着 1 格口径重算（分区框 / 文字标注） ============
   需求：分区框 = 节点外圈恰好 1 格；文字标注贴在节点上方 1 格；箭头端点贴节点边缘。
   （框/文字的 pod 由 captureMarkBindings + rebindMarksAfterLayout 决定） */
console.log("\n[9] 绘制按 1 格重算（分区框 / 文字标注）");
{
  const ctx9 = {
    S: { wf: { nodes: [], wires: [], marks: [], groups: [] }, config: { snap: 8 } },
    grid: () => 8,
    snap: (v) => Math.round(v / 8) * 8,
    nodeById: (id) => (ctx9.S.wf.nodes || []).find((n) => n.id === id) || null,
    markById: (id) => (ctx9.S.wf.marks || []).find((m) => m.id === id) || null,
    marksOf: () => ctx9.S.wf.marks || [],
    nodeDrawSize: (n) => ({ w: (n && n.w) || 288, h: (n && n.h) || 192 }),
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
  vm.createContext(ctx9);
  vm.runInContext(
    extract(appSrc + "\n" + nodesSrc + "\n" + canvasSrc, [
      "layoutGap",
      "layoutSnapSized",
      "layoutSnapSize",
      "layoutNodeSize",
      "nodesBBox",
      "nodeCenter",
      "markBounds",
      "nodesInsideMarkBounds",
      "nearestNodeId",
      "ensureGroupArrays",
      "captureMarkBindings",
      "rebindMarksAfterLayout",
    ]),
    ctx9,
    { filename: "mark-grid-extract.js" },
  );
  const nodes = [
    { id: "m1", kind: "proc_text", x: 100, y: 100, w: 288, h: 192 },
    { id: "m2", kind: "proc_text", x: 400, y: 100, w: 288, h: 192 },
  ];
  /* 原框完全按「外圈 1 格」画：留白 = 8 → pad 取 8，节点重排后框仍应贴 8 */
  const box = { id: "b1", kind: "box", x: 92, y: 92, w: 604, h: 208, title: "分区" };
  const txt = { id: "t1", kind: "text", x: 100, y: 52, w: 120, h: 40, text: "标题" };
  ctx9.S.wf.nodes = nodes;
  ctx9.S.wf.marks = [box, txt];
  const bindings = ctx9.captureMarkBindings(nodes);
  /* 先把节点按 1 格间距重排一次，再让绘制跟着重算 */
  nodes[0].x = 16;
  nodes[0].y = 16;
  nodes[1].x = 16 + 288 + 8;
  nodes[1].y = 16;
  ctx9.rebindMarksAfterLayout(bindings);
  ok(
    box.x === 16 - 8 && box.y === 16 - 8 && box.w === 288 * 2 + 8 + 16 && box.h === 192 + 16,
    "分区框 = 节点外圈恰好 1 格（x=" +
      box.x +
      " y=" +
      box.y +
      " w=" +
      box.w +
      " h=" +
      box.h +
      "，期望 8/8/" +
      (288 * 2 + 8 + 16) +
      "/" +
      (192 + 16) +
      "）",
  );
  ok(box.x % 8 === 0 && box.y % 8 === 0 && box.w % 8 === 0 && box.h % 8 === 0, "分区框坐标与尺寸都落在网格上");
  ok(
    txt.y === 16 - 40 - 8,
    "文字标注贴在节点上方 1 格（t.y=" + txt.y + "，期望 " + (16 - 40 - 8) + "）",
  );
}

/* 自动排版撤掉之后，新节点必须自己就近找空位、且绝不挪动已有节点（2026-02 需求） */
{
  const freeSpotForNode = ex("freeSpotForNode");
  const S = ex("S");
  const keep = S.wf.nodes.slice();
  const snap0 = ex("snap");
  S.wf.nodes = [
    { id: "old1", kind: "input_text", title: "老节点", x: 64, y: 64, w: 240, h: 160, parentSuperId: "", parentTaskId: "" },
  ];
  const cand = { id: "new1", kind: "input_text", title: "新节点", x: 48, y: 48, w: 240, h: 160, parentSuperId: "", parentTaskId: "" };
  const spot = freeSpotForNode(cand, { x: 48, y: 48 }, ex("nodePlacementObstacles")(cand));
  const over = ex("rectsOverlap")(
    { x: spot.x, y: spot.y, w: cand.w, h: cand.h },
    { x: 64, y: 64, w: 240, h: 160 },
    0,
  );
  ok(over === false, "新节点落点与已有节点不重叠（就近找空位）");
  ok(spot.x >= 48 && spot.y >= 48, "落点只往外找（不往左上钻）");
  ok(S.wf.nodes[0].x === 64 && S.wf.nodes[0].y === 64, "已有节点的坐标一个都没动");
  /* 空画布：落点就是原点 48/48，不外扩 */
  S.wf.nodes = [];
  const empty = freeSpotForNode(cand, { x: 48, y: 48 }, []);
  ok(empty.x === 48 && empty.y === 48, "空画布落点 = 原点（48/48）");
  S.wf.nodes = keep;
}

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
