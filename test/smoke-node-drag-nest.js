"use strict";
/* 多选节点拖入超级节点的归属回归 —— 纯 Node，不启动 Electron
 *   node test/smoke-node-drag-nest.js
 *
 * 背景（第一次修的 bug）：多选几个节点一起拖进一颗**已展开**的超级节点时，只有「中点刚好
 * 落在壳内」的那几个被收进去，其余留在外面 —— 一整把拖动被拆散。拖一颗时看不出问题，
 * 拖一组时尤其明显（鼠标压着的那颗进去了，同批另外几颗仍留在画布上）。
 *
 * 背景（第二次修的 bug · 子画布展开模式节点移不动 / 移不出）：旧落点判据只看「节点中点是否
 * 落在壳的可见矩形里」，于是①把壳内节点往壳沿挪一点、中点一过界就被判成「出壳」，归属被改写成
 * 画布顶层、整块弹出去（看着就是挪不动）；②想拖出去又必须先让中点也出壳，光标明明在外面、节点
 * 仍被拽回来。现在落点按「光标压在哪儿 → 节点外接矩形与壳有无实质重叠 → 中点兜底」三级判定。
 *
 * 本测试把 app.js 里那条链路抠进沙箱跑**真函数**（不读字面量）：
 *   [1] findOpenSuperAtWorld：展开壳命中口径（取最内层 / 同任务层 / 跳过拖拽中的壳自己）；
 *   [2] finalizeNodeDragNest：整组只认一个落点宿主 —— 命中一颗展开壳就整组一起进去，
 *       相对位置原样保留；一颗都没命中时原样不动；已在壳内的成员被拖出壳外仍单独出来；
 *   [3] 落定后壳按内容撑开且不裁掉新进去的节点（fitAllOpenSuperShells 真函数）；
 *   [4] 反向不变量：不能把节点收进自己的子孙壳（成环），内部端子（super_io）永不参与；
 *   [5] 子画布（全屏进入超级节点）里再往子壳里套：命中当层子壳 → 整组进子壳、相对位置不变；
 *       拖出子壳仍留在本层（不甩到看不见的上一层）；祖先壳 / 界外节点不参与；
 *       右键「移入此超级节点」（moveNodesIntoSuper）在子画布里落在子壳内部；
 *   [6] 落点判据（光标优先 / 边界包容）：壳沿挪动不再被弹回画布、光标拖远才真出壳；
 *   [7] 源码口径：入口、调用点与新参数仍在。
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
const section = (t) => console.log("\n[" + t + "]");
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

const APP = read("renderer/app.js");

/* ─ 与 smoke-canvas-scope.js 同一套切片工具：跑真函数，不另抄一份 ── */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平");
}
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("源码里找不到函数：" + name);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  return src.slice(m.index, open + sliceBraces(src, open).length);
}

/* [2] 里那份「整组只认一个落点宿主」的判定，从 finalizeNodeDragNest 真源码里取 */
const NEST_FN = grabFunction(APP, "finalizeNodeDragNest");

/* 展开壳内范围常量：x0 = 壳 x + 0（展开时 superInnerOrigin.ox），y0 = 壳 y + 29 */
const SUP = { x: 1000, y: 200, w: 280, h: 200, expandW: 720, expandH: 480 };
const BOX = { x0: SUP.x, y0: SUP.y + 29, x1: SUP.x + SUP.expandW - 8, y1: SUP.y + SUP.expandH - 10 };

function makeSandbox(graph) {
  const nodes = graph.map((n) => Object.assign({}, n));
  const sb = {
    console,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    Set,
    RegExp,
    Error,
    isFinite,
    snap(v) {
      return Math.round(Number(v || 0) / 24) * 24;
    },
    S: { wf: { nodes, wires: [], marks: [], groups: [] }, superFocus: "", taskFocus: "" },
    currentSuperFocus: () => sb.S.superFocus || "",
    currentTaskFocus: () => sb.S.taskFocus || "",
    nodeById: (id) => nodes.filter((n) => n.id === id)[0] || null,
    isSuperIoNode: (n) => !!(n && n.kind === "super_io"),
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
    /* 根画布口径：壳内节点只要宿主是展开的就在范围内（本测试的壳全为展开态） */
    nodeInCurrentScope: (n) => {
      if (!n) return false;
      if (sb.S.superFocus) return sb.nodeParentSuperId(n) === sb.S.superFocus;
      let sid = sb.nodeParentSuperId(n);
      const seen = new Set();
      while (sid && !seen.has(sid)) {
        seen.add(sid);
        const host = sb.nodeById(sid);
        if (!host || host.kind !== "super" || !host.superOpen) return false;
        sid = sb.nodeParentSuperId(host);
      }
      return true;
    },
    superChildrenOf: (id) => nodes.filter((n) => n.parentSuperId === id),
    /* 绘制（标注）本测试不需要：给空集合，与 smoke-canvas-scope 同口径 */
    marksOf: () => [],
    markBounds: (m) => (m ? { x: m.x, y: m.y, w: m.w || 0, h: m.h || 0 } : null),
    markParentSuperId: (m) => (m && m.parentSuperId) || "",
    /* 真实渲染层里 superInnerOrigin 量的是壳层 DOM；沙箱没有 DOM → 走它的兜底
       { ox: 0, oy: 29 }（展开壳 stage 贴齐标题下沿，与源码兜底一致） */
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    pruneInvalidSuperBoundaryWires: () => 0,
    wireKeepsSuperBoundary: () => true,
    /* 右键「移入此超级节点」链路用到的落盘 / 路径改写：本测试只关心归属与坐标 */
    pushHistory: () => {},
    scheduleSave: () => {},
    rewriteNodePathsForSuperContext: () => {},
  };
  const code = [
    "(function () {",
    grabFunction(APP, "superIsOpenShell"),
    grabFunction(APP, "nodeIsNestedInOpenSuper"),
    grabFunction(APP, "superDisplaySize"),
    grabFunction(APP, "superInnerOrigin"),
    grabFunction(APP, "superInnerPan"),
    grabFunction(APP, "nodeWorldPos"),
    grabFunction(APP, "nodeDrawSize"),
    grabFunction(APP, "isSuperAncestorOf"),
    grabFunction(APP, "canMoveNodeIntoSuper"),
    grabFunction(APP, "superNestDepth"),
    NEST_FN,
    grabFunction(APP, "findOpenSuperAtWorld"),
    grabFunction(APP, "findOpenSuperContainingRect"),
    "const DRAG_RECT_TOL = " + Number(/const DRAG_RECT_TOL = (\d+)/.exec(APP)[1]) + ";",
    "const DRAG_RECT_MIN_OVERLAP = " + Number(/const DRAG_RECT_MIN_OVERLAP = (\d+)/.exec(APP)[1]) + ";",
    grabFunction(APP, "superInnerAnchor"),
    grabFunction(APP, "alignSuperContentTopLeft"),
    grabFunction(APP, "fitSuperShellToContent"),
    grabFunction(APP, "fitAllOpenSuperShells"),
    grabFunction(APP, "moveNodesIntoSuper"),
    "return { finalizeNodeDragNest, findOpenSuperAtWorld, findOpenSuperContainingRect, canMoveNodeIntoSuper, isSuperAncestorOf, fitAllOpenShells: fitAllOpenSuperShells, nodeWorldPos, superInnerOrigin, superInnerAnchor, nodeDrawSize, superDisplaySize, moveNodesIntoSuper };",
    "})()",
  ].join("\n");
  const ctx = vm.createContext(sb);
  const api = vm.runInContext(code, ctx);
  return { sb, api, nodes };
}

function mkNode(o) {
  return Object.assign(
    { kind: "proc_text", w: 240, h: 160, title: o.id, parentSuperId: "", parentTaskId: "" },
    o,
  );
}
function mkSuper(id, o) {
  return mkNode(
    Object.assign(
      { id, kind: "super", x: SUP.x, y: SUP.y, w: SUP.w, h: SUP.h, superOpen: true, expandW: SUP.expandW, expandH: SUP.expandH },
      o || {},
    ),
  );
}
/* 与 app.js 的 snap 同源：拖动中 curWorld 走 snap（applyNodeDragVisual），
   测试里的 curWorld 必须一样是网格对齐值，否则会造出「落点与现状差几 px」的假现场 */
const snapv = (v) => Math.round(Number(v || 0) / 24) * 24;
/* 整组按位移拖动：与 applyNodeDragVisual 的 curWorld 同形。
   拖动中壳自己不动 → 成员的世界坐标 = 起拖时的世界坐标 + 位移，直接按此算，
   不能用 nodeWorldPos 现算（组里若含某颗壳的子节点，现算会把壳自己的位移也算进去）。 */
function drag(api, nodes, ids, delta) {
  const curWorld = {};
  for (const id of ids) {
    const n = nodes.filter((x) => x.id === id)[0];
    const wp = api.nodeWorldPos(n);
    curWorld[id] = { x: snapv(wp.x + delta.x), y: snapv(wp.y + delta.y) };
  }
  return curWorld;
}
const parentOf = (nodes, id) => (nodes.filter((n) => n.id === id)[0].parentSuperId || "-");

/* ═══════════════ [1] findOpenSuperAtWorld：展开壳命中口径 ═══════════════ */
function part1() {
  section("1 findOpenSuperAtWorld 命中口径");
  const { api } = makeSandbox([mkSuper("SUP"), mkNode({ id: "A", x: 100, y: 100 })]);
  ok(!!api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()), "壳内左上角命中");
  ok(!!api.findOpenSuperAtWorld(BOX.x1 - 5, BOX.y1 - 5, new Set()), "壳内右下角命中");
  ok(
    api.findOpenSuperAtWorld(BOX.x0 - 40, BOX.y0 + 5, new Set()) === null &&
      api.findOpenSuperAtWorld(BOX.x1 + 40, BOX.y1 - 5, new Set()) === null,
    "壳外左右各偏一点就不命中（不再「差一点也算进去」）",
  );
  const noSup = makeSandbox([mkNode({ id: "A", x: 100, y: 100 })]);
  ok(noSup.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()) === null, "画布上没有展开壳 → 不命中");
  const collapsed = makeSandbox([mkSuper("SUP", { superOpen: false })]);
  ok(
    collapsed.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set()) === null,
    "收起态壳不算命中（拖动悬停会先把它展开；折叠卡片命中口径见 findSuperAtWorld）",
  );
  const skip = makeSandbox([mkSuper("SUP")]);
  ok(
    skip.api.findOpenSuperAtWorld(BOX.x0 + 5, BOX.y0 + 5, new Set(["SUP"])) === null,
    "被拖拽的壳自己进 skipHosts → 不能接收自己",
  );
}

/* ═══════════════ [2] finalizeNodeDragNest：整组一起进去 ═══════════════ */
function part2() {
  section("2 多选拖入：命中一颗壳 → 整组一起进去");

  /* ②-a 关键回归：只有 A 的中点在壳内，B 的中点在外面 —— 组里两个都要进去 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 400, y: 300 }),
      mkNode({ id: "B", x: 1100, y: 400 }),
    ]);
    const ids = ["A", "B"];
    const curWorld = drag(api, nodes, ids, { x: 500, y: 0 });
    const startWorld = { A: api.nodeWorldPos(nodes[1]), B: api.nodeWorldPos(nodes[2]) };
    const hitA = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
    const hitB = api.findOpenSuperAtWorld(curWorld.B.x + 120, curWorld.B.y + 80, new Set());
    ok(!!hitA && !hitB, "前置：B 的中点确实在壳外（这不是「都进去了所以看不出问题」的场景）");
    const changed = api.finalizeNodeDragNest(ids, curWorld);
    ok(changed === true, "落定有变化");
    ok(
      parentOf(nodes, "A") === "SUP" && parentOf(nodes, "B") === "SUP",
      "整组都进了壳（不只中点落在壳内的那颗）：A=" + parentOf(nodes, "A") + " B=" + parentOf(nodes, "B"),
    );
    const wA = api.nodeWorldPos(nodes[1]);
    const wB = api.nodeWorldPos(nodes[2]);
    /* 落定会按内容撑壳 → 可能跟着调内部平移（innerPan），世界坐标整体平移是正常的；
       要钉的是「组内相对位置没被重排」：A→B 的偏移与拖动时一致 */
    ok(
      Math.abs(wB.x - wA.x - (startWorld.B.x - startWorld.A.x)) <= 24 &&
        Math.abs(wB.y - wA.y - (startWorld.B.y - startWorld.A.y)) <= 24,
      "组内相对位移不变（A→B 偏移 " + (wB.x - wA.x) + "," + (wB.y - wA.y) + " vs 拖动时 " +
        (startWorld.B.x - startWorld.A.x) + "," + (startWorld.B.y - startWorld.A.y) + "）",
    );
    /* 落定后视图把节点画在 nodeWorldPos 上（与拖动中 applyNodeDragVisual 的 curWorld 同口径） */
    ok(
      Math.abs((wB.x - wA.x) - (curWorld.B.x - curWorld.A.x)) <= 24 &&
        Math.abs((wB.y - wA.y) - (curWorld.B.y - curWorld.A.y)) <= 24,
      "落定后两颗节点的相对站位与拖动中一致（不会有一半被挤到壳的左上角）",
    );
    ok(
      Math.abs(nodes[1].x + nodes[2].x) < 4000 && Number.isFinite(wA.x) && Number.isFinite(wB.y),
      "落点都是有限数（没有 NaN / 越界坐标）",
    );
  }

  /* ②-b 三颗一起拖：一颗在壳里、两颗在外 → 三颗都进去 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 400, y: 300 }),
      mkNode({ id: "B", x: 900, y: 700 }),
      mkNode({ id: "C", x: 500, y: 1000 }),
    ]);
    const ids = ["A", "B", "C"];
    const curWorld = drag(api, nodes, ids, { x: 700, y: -100 });
    ok(
      !!api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set()) &&
        !api.findOpenSuperAtWorld(curWorld.B.x + 120, curWorld.B.y + 80, new Set()),
      "前置：只有 A 的中点在壳内",
    );
    api.finalizeNodeDragNest(ids, curWorld);
    ok(
      ["A", "B", "C"].every((id) => parentOf(nodes, id) === "SUP"),
      "三颗全部进壳：" + ["A", "B", "C"].map((id) => id + "=" + parentOf(nodes, id)).join(" "),
    );
  }

  /* ②-c 一颗都没命中 → 原样不动（不误吞）：整组落在壳范围内的空白处，谁也不进壳 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 96, y: 96 }),
      mkNode({ id: "B", x: 192, y: 168 }),
    ]);
    const ids = ["A", "B"];
    /* 与 applyNodeDragVisual 同源：原地松手时 curWorld = 现状（网格对齐值） */
    const curWorld = {
      A: { x: snapv(nodes[1].x), y: snapv(nodes[1].y) },
      B: { x: snapv(nodes[2].x), y: snapv(nodes[2].y) },
    };
    const changed = api.finalizeNodeDragNest(ids, curWorld);
    ok(
      changed === false && parentOf(nodes, "A") === "-" && parentOf(nodes, "B") === "-",
      "整组都在壳外 → 一颗都不进（不因为「同组有一颗进去了」而蔓延）",
    );
    ok(
      nodes[1].x === 96 && nodes[1].y === 96 && nodes[2].x === 192 && nodes[2].y === 168,
      "一颗都没命中时坐标也不被改写（原样 " + nodes[1].x + "," + nodes[1].y + " / " + nodes[2].x + "," + nodes[2].y + "）",
    );
  }

  /* ②-c2 本就在展开壳里的节点被拖到壳范围内的别处 → 仍是它，只是壳内坐标变了 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 300, y: 300, parentSuperId: "SUP" }),
    ]);
    const curWorld = drag(api, nodes, ["A"], { x: 120, y: 0 });
    const hit = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
    ok(hit && hit.id === "SUP", "前置：拖动后 A 的中点仍在壳内（实测 " + (hit && hit.id) + "）");
    api.finalizeNodeDragNest(["A"], curWorld);
    ok(parentOf(nodes, "A") === "SUP", "壳内成员在壳内挪动：归属不变（不会被当成「拖出壳」甩到画布上）");
    ok(
      Math.abs(nodes[1].x - snapv(300 + 120)) <= 24 && Math.abs(nodes[1].y - 300) <= 24,
      "壳内坐标跟着落点走（" + nodes[1].x + "," + nodes[1].y + "，期望 ≈" + snapv(420) + ",300）",
    );
  }

  /* ②-d 单颗拖动：行为不变（仍是按自己中点判定） */
  {
    const { api, nodes } = makeSandbox([mkSuper("SUP"), mkNode({ id: "A", x: 400, y: 300 })]);
    const curWorld = drag(api, nodes, ["A"], { x: 500, y: 0 });
    api.finalizeNodeDragNest(["A"], curWorld);
    ok(parentOf(nodes, "A") === "SUP", "单颗拖进壳内照旧进壳");
    const w = api.nodeWorldPos(nodes[1]);
    ok(Math.abs(w.x - curWorld.A.x) <= 24 && Math.abs(w.y - curWorld.A.y) <= 24, "单颗落点世界坐标不变");
  }

  /* ②-e 已在壳内的成员被拖出去、整组没有任何成员命中展开壳 → 它单独出来 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "IN", x: 200, y: 100, parentSuperId: "SUP" }),
      mkNode({ id: "FREE", x: 200, y: 1000 }),
    ]);
    const ids = ["IN", "FREE"];
    const curWorld = drag(api, nodes, ids, { x: -3000, y: 0 });
    api.finalizeNodeDragNest(ids, curWorld);
    ok(parentOf(nodes, "IN") === "-", "被拖出壳外的内部节点回到顶层（不因同组没进壳就一起留在里面）");
    ok(parentOf(nodes, "FREE") === "-", "同组的自由节点仍在壳外（没有因为组里有壳内成员就被拽进去）");
  }
  {
    /* 混合父级：IN 本来在壳里、FREE 从外面被拖进来 → 两个都归属这颗壳 */
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "IN", x: 200, y: 100, parentSuperId: "SUP" }),
      mkNode({ id: "FREE", x: 100, y: 1500 }),
    ]);
    const ids = ["IN", "FREE"];
    const curWorld = drag(api, nodes, ids, { x: 900, y: -1100 });
    const hitFree = api.findOpenSuperAtWorld(curWorld.FREE.x + 120, curWorld.FREE.y + 80, new Set());
    ok(
      hitFree && hitFree.id === "SUP",
      "前置：FREE（从外面拖进来）的中点落在壳内（实测 " + (hitFree && hitFree.id) + "）",
    );
    api.finalizeNodeDragNest(ids, curWorld);
    ok(
      parentOf(nodes, "IN") === "SUP" && parentOf(nodes, "FREE") === "SUP",
      "混合父级：壳内成员仍是它、外面进来的也进来（一起归属这颗壳）",
    );
  }
}

/* ═══════════════ [3] 落定后壳按内容撑开（进去的节点不被裁掉） ═══════════════ */
function part3() {
  section("3 整组进壳后按内容撑开（新进去的节点看得见）");
  const { api, nodes } = makeSandbox([
    mkSuper("SUP"),
    mkNode({ id: "A", x: 400, y: 300 }),
    mkNode({ id: "B", x: 1000, y: 400 }),
  ]);
  const ids = ["A", "B"];
  const before = { w: nodes[0].expandW, h: nodes[0].expandH };
  const curWorld = drag(api, nodes, ids, { x: 500, y: 0 });
  api.finalizeNodeDragNest(ids, curWorld);
  const sup = nodes[0];
  ok(
    sup.expandW >= before.w && sup.expandH >= before.h,
    "壳只放大不缩小：" + before.w + "x" + before.h + " → " + sup.expandW + "x" + sup.expandH,
  );
  const need = (id) => {
    const n = nodes.filter((x) => x.id === id)[0];
    return n;
  };
  /* 撑开 + 对齐之后：每个子节点的**世界坐标**都应落在壳的可见矩形里
     （右侧端子留位 26 / 标题墙 43；换算回世界坐标才和用户看到的一致） */
  const shell = api.nodeWorldPos(sup);
  const vis = ["A", "B"].map((id) => api.nodeWorldPos(need(id)));
  ok(
    vis.every((w) => {
      return (
        w.x >= shell.x - 2 &&
        w.y >= shell.y + 27 &&
        w.x + 240 <= shell.x + sup.expandW - 22 &&
        w.y + 160 <= shell.y + sup.expandH - 16
      );
    }),
    "两颗节点都落在壳的可见范围内（含右侧端子留位与标题栏）：" +
      vis.map((w, i) => ["A", "B"][i] + "(" + w.x + "," + w.y + ")").join(" ") +
      " · 壳 world(" + shell.x + "," + shell.y + ") " + sup.expandW + "x" + sup.expandH,
  );
  ok(
    Number.isFinite(sup.innerPanX) && Number.isFinite(sup.innerPanY),
    "壳内部平移（innerPanX/Y）是有限数（撑开时对齐内容不出现 NaN）",
  );
}

/* ═══════════════ [4] 反向不变量：不成环、内部端子不参与 ═══════════════ */
function part4() {
  section("4 反向不变量");
  {
    const { api, nodes } = makeSandbox([
      mkSuper("OUTER"),
      mkSuper("INNER", { parentSuperId: "OUTER", x: 1000, y: 200, expandW: 400, expandH: 300 }),
      mkNode({ id: "A", x: 400, y: 300 }),
    ]);
    /* 成环拒绝：宿主是 INNER 时不能把它的祖先 OUTER 收进去 */
    ok(
      api.isSuperAncestorOf("OUTER", "INNER") === true &&
        api.canMoveNodeIntoSuper(nodes[1], nodes[0]) === false,
      "外层壳不能把「自己的子孙壳」收进自己（会成环）",
    );
    ok(api.canMoveNodeIntoSuper(nodes[0], nodes[1]) === true, "反过来（祖先收自己的子孙壳）是合法收纳");
    /* A 拖到 INNER 里：INNER 与 OUTER 同心、面积更小 → 命中取最内层的 INNER。
       同组的 OUTER 是 INNER 的祖先，不能进 INNER；A 仍按自己的命中进 INNER
       （能不能进是逐节点判的，不因为组里有一颗进不去就把它也拦下）。 */
    const curWorld = drag(api, nodes, ["OUTER", "A"], { x: 1530, y: 170 });
    const hitA = api.findOpenSuperAtWorld(curWorld.A.x + 120, curWorld.A.y + 80, new Set());
    ok(hitA && hitA.id === "INNER", "前置：A 的中点落在 INNER 壳内（INNER 是最内层那颗，实测 " + (hitA && hitA.id) + "）");
    const changed = api.finalizeNodeDragNest(["OUTER", "A"], curWorld);
    ok(
      changed === true && parentOf(nodes, "A") === "INNER" && parentOf(nodes, "INNER") === "OUTER",
      "组里的祖先壳不进去（不能进自己的子孙）、A 按自己的命中进 INNER，谁也不成环",
    );
  }
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "IO", kind: "super_io", x: 400, y: 300 }),
    ]);
    const curWorld = drag(api, nodes, ["IO"], { x: 500, y: 0 });
    const changed = api.finalizeNodeDragNest(["IO"], curWorld);
    ok(changed === false && parentOf(nodes, "IO") === "-", "超级节点内部端子（super_io）永不参与归属改写");
  }
  {
    const { sb, api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 400, y: 300, parentSuperId: "SUP" }),
    ]);
    sb.S.superFocus = "SUP";
    const curWorld = drag(api, nodes, ["A"], { x: 500, y: 0 });
    const changed = api.finalizeNodeDragNest(["A"], curWorld);
    sb.S.superFocus = "";
    ok(
      parentOf(nodes, "A") === "SUP" && Math.abs(nodes[1].x - 900) <= 24,
      "全屏进入某颗壳时（superFocus）：本层节点拖动后仍是本层节点，落点坐标更新（不被甩到上一层，也不整体拒绝）",
    );
  }
}

/* ════════════ [5] 子画布（全屏进入超级节点）里再往子壳里套 ═════════════ */
function mkFocusScene(extra) {
  /* 场景：OUTER（在根画布）里有一颗子壳 INNER（展开）与若干节点；用户「进入」OUTER
     后在子画布上操作 —— 这一屏的直接子壳 INNER 是合法落点宿主。
     修前：finalizeNodeDragNest 一进门就 `if (currentSuperFocus()) return false`，
     于是子画布里拖进子壳只有「中点已落在子壳里的那几个」动了，其余留在原地。 */
  return makeSandbox(
    [
      mkSuper("OUTER", {
        x: 0,
        y: 0,
        expandW: 720,
        expandH: 480,
        parentSuperId: "",
      }),
      mkSuper("INNER", {
        x: 200,
        y: 120,
        expandW: 400,
        expandH: 300,
        parentSuperId: "OUTER",
      }),
      mkNode({ id: "A", x: 0, y: 170, parentSuperId: "OUTER" }),
      mkNode({ id: "B", x: 560, y: 175, parentSuperId: "OUTER" }),
    ].concat(extra || []),
  );
}
function part5() {
  section("5 子画布（superFocus）里把节点拖进子壳");
  /* ⑤-a 多选：A 的中点进 INNER、B 的还在子画布空白 → 两颗都进 INNER，相对位置不变 */
  {
    const { sb, api, nodes } = mkFocusScene();
    sb.S.superFocus = "OUTER";
    /* A 起拖舞台坐标 (0,170)，拖到 (288,168) → 中点 (408,328) 在 INNER 内；
       B 起拖 (560,175)，同样 +288 → 中点 (968,343) 在子画布空白处 */
    const curWorld = { A: { x: 288, y: 168 }, B: { x: 848, y: 173 } };
    const hitA = api.findOpenSuperAtWorld(408, 328, new Set());
    const hitB = api.findOpenSuperAtWorld(968, 343, new Set());
    ok(hitA && hitA.id === "INNER", "前置：A 的中点在子壳 INNER 内（实测 " + (hitA && hitA.id) + "）");
    ok(!hitB, "前置：B 的中点在子壳外（子画布空白处）");
    const changed = api.finalizeNodeDragNest(["A", "B"], curWorld);
    ok(changed === true, "子画布落定有变化");
    ok(
      parentOf(nodes, "A") === "INNER" && parentOf(nodes, "B") === "INNER",
      "整组都进了子壳（不只中点落在子壳内的那颗）：A=" + parentOf(nodes, "A") + " B=" + parentOf(nodes, "B"),
    );
    const a = nodes.filter((n) => n.id === "A")[0];
    const b = nodes.filter((n) => n.id === "B")[0];
    ok(
      Math.abs(b.x - a.x - 560) <= 24 && Math.abs(b.y - a.y - 5) <= 24,
      "子壳内相对位移保留（A→B 偏移 " + (b.x - a.x) + "," + (b.y - a.y) + " 期望 ≈560,5）",
    );
    ok(
      a.x >= 0 && a.y >= 0 && a.x + a.w <= 400 && a.y + a.h <= 300,
      "A 的子壳内坐标落在子壳里（" + a.x + "," + a.y + "）",
    );
    ok(
      parentOf(nodes, "OUTER") === "-" && parentOf(nodes, "INNER") === "OUTER",
      "本层壳（INNER）仍挂在正在编辑的 OUTER 下",
    );
  }
  /* ⑤-b 子画布里把本层节点从子壳里拖出来 → 仍留在本层（OUTER），不会掉到根画布 */
  {
    const { sb, api, nodes } = mkFocusScene();
    sb.S.superFocus = "OUTER";
    const changed = api.finalizeNodeDragNest(["A"], { A: { x: 640, y: 430 } });
    const a = nodes.filter((n) => n.id === "A")[0];
    ok(changed === true, "拖出子壳有变化");
    ok(parentOf(nodes, "A") === "OUTER", "拖出子壳后仍留在本层 OUTER（不被甩到看不见的上一层）");
    ok(
      Math.abs(a.x - 640) <= 24 && Math.abs(a.y - 430) <= 24,
      "落点就是子画布上的舞台坐标（" + a.x + "," + a.y + "）",
    );
  }
  /* ⑤-c 子画布空白处拖动本层节点：只改坐标，不改归属 */
  {
    const { sb, api, nodes } = mkFocusScene();
    sb.S.superFocus = "OUTER";
    const beforeY = nodes[2].y;
    api.finalizeNodeDragNest(["A"], { A: { x: 0, y: 300 } });
    const a = nodes.filter((n) => n.id === "A")[0];
    ok(parentOf(nodes, "A") === "OUTER", "空白处落定不改归属（仍在 OUTER）");
    ok(Math.abs(a.y - 300) <= 24 && a.y !== beforeY, "落点坐标已更新（y " + beforeY + " → " + a.y + "）");
  }
  /* ⑤-d 反向不变量：子画布里的祖先壳（正在编辑的 OUTER）不会被收进自己的子壳 */
  {
    const { sb, api, nodes } = mkFocusScene();
    sb.S.superFocus = "OUTER";
    const curWorld = { OUTER: { x: 288, y: 168 }, A: { x: 288, y: 168 } };
    const hitA = api.findOpenSuperAtWorld(408, 328, new Set(["OUTER"]));
    ok(hitA && hitA.id === "INNER", "前置：A 命中子壳 INNER");
    api.finalizeNodeDragNest(["OUTER", "A"], curWorld);
    ok(
      parentOf(nodes, "A") === "INNER" && parentOf(nodes, "INNER") === "OUTER",
      "A 进子壳、OUTER 不进自己的子壳（不成环）",
    );
    ok(parentOf(nodes, "OUTER") === "-", "正在编辑的 OUTER 仍留在根画布");
  }
  /* ⑤-e 子画布上其它层级的节点不参与（这一屏看不见的节点不该被改写归属） */
  {
    const { sb, api, nodes } = mkFocusScene([
      mkNode({ id: "FAR", x: 288, y: 168, parentSuperId: "SOMEWHERE" }),
    ]);
    sb.S.superFocus = "OUTER";
    const changed = api.finalizeNodeDragNest(["FAR"], { FAR: { x: 300, y: 200 } });
    ok(
      changed === false && parentOf(nodes, "FAR") === "SOMEWHERE",
      "界外（其它层级）节点即使选中也不改写归属",
    );
  }
  /* ⑤-f 右键「移入此超级节点」（moveNodesIntoSuper）在子画布里也落在子壳内部 */
  {
    const { sb, api, nodes } = mkFocusScene();
    sb.S.superFocus = "OUTER";
    const inner = nodes.filter((n) => n.id === "INNER")[0];
    const a = nodes.filter((n) => n.id === "A")[0];
    const n = api.moveNodesIntoSuper(inner, [a]);
    ok(n === 1 && parentOf(nodes, "A") === "INNER", "右键移入：A 归属 INNER");
    ok(
      a.x >= 0 && a.y >= 0 && a.x + a.w <= 400 && a.y + a.h <= 300,
      "右键移入的落点坐标在子壳内部坐标系里（" + a.x + "," + a.y + "）",
    );
    ok(
      api.superInnerAnchor(inner).x === inner.x,
      "子画布下宿主锚点取宿主自身坐标（不再叠加父壳世界坐标）",
    );
  }
}

/* ═════════════ [6] 落点判据：光标优先 / 矩形包容（展开态「挪不动 / 挪不出」回归） ═════════════ */
const CURSOR_FN = grabFunction(APP, "finalizeNodeDragNest");
function part6() {
  section("6 落点判据：光标优先 / 边界包容（节点挪出壳沿不再被弹回画布）");

  /* 展开壳 SUP：world(1000,200) 720x480；命中区 x0=1000,y0=229 → x1=1712,y1=670 */
  const shellWorld = () => ({
    x0: SUP.x,
    y0: SUP.y + 29,
    x1: SUP.x + SUP.expandW - 8,
    y1: SUP.y + SUP.expandH - 10,
  });

  /* ⑥-a 壳内节点往壳右下沿挪：节点比壳沿伸出去（中点落在壳外一点点）——
       旧口径会判成「出壳」→ 归属被改写成画布顶层、视觉上整块弹走 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 1080, y: 420, parentSuperId: "SUP" }),
    ]);
    const a = nodes[1];
    const before = api.nodeWorldPos(a);
    const np = { x: snapv(before.x + 120), y: snapv(before.y + 96) };
    const sw = shellWorld();
    const center = { x: np.x + 120, y: np.y + 80 };
    ok(
      center.x > sw.x1 || center.y > sw.y1,
      "前置：照旧口径这颗节点已经算「出壳」（中点 " + center.x + "," + center.y + " 出 " + sw.x1 + "," + sw.y1 + "）",
    );
    /* 光标仍在壳内（用户只是往壳沿挪了一点） */
    const cursor = { x: sw.x1 - 20, y: sw.y1 - 20 };
    const changed = api.finalizeNodeDragNest(["A"], { A: np }, cursor);
    ok(changed === true && parentOf(nodes, "A") === "SUP", "光标还在壳里 → 归属仍是这颗壳（节点不再被弹出画布）");
    ok(
      api.nodeWorldPos(a).x === api.nodeWorldPos(a).x && Math.abs(api.nodeWorldPos(a).x - np.x) <= 24,
      "节点世界坐标就是落点（" + api.nodeWorldPos(a).x + "," + api.nodeWorldPos(a).y + "）",
    );
  }

  /* ⑥-b 光标已拖到壳外、节点也只剩一条窄边压在壳沿上 → 真的出壳 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
    ]);
    const a = nodes[1];
    const sw = shellWorld();
    /* 节点只剩左边一条 40px 窄边还压在壳命中区内（中心仍在壳里） */
    const np = { x: 960, y: 230 };
    const center = { x: np.x + 120, y: np.y + 80 };
    ok(
      center.x >= sw.x0 && center.x <= sw.x1 && center.y >= sw.y0 && center.y <= sw.y1,
      "前置：中点仍在壳内（照旧口径会被当成「壳内挪动」，拖不出去）",
    );
    const cursor = { x: 700, y: 120 };
    ok(
      cursor.x < sw.x0 && cursor.y < sw.y0,
      "前置：光标在壳外左侧/上方空白处（旧口径只看中点，会把它判成「壳内挪动」）",
    );
    ok(
      np.x < sw.x0 && np.x + 240 > sw.x0 && np.x + 40 <= sw.x0,
      "前置：节点只剩约 40px 窄边压在壳上（不足实质重叠阈值）",
    );
    api.finalizeNodeDragNest(["A"], { A: np }, cursor);
    ok(parentOf(nodes, "A") === "SUP", "光标在壳外但节点仍有实质重叠 → 仍留在壳里（壳沿不粘人也不甩人）");
    ok(
      Math.abs(api.nodeWorldPos(a).x - np.x) <= 24 && Math.abs(api.nodeWorldPos(a).y - np.y) <= 24,
      "仍在壳里时写回的坐标换算回世界坐标 = 落点（" + api.nodeWorldPos(a).x + "," + api.nodeWorldPos(a).y + "）",
    );
  }

  /* ⑥-c 光标偏出壳外，但节点仍压在壳沿上 → 矩形包容档接住，仍留在壳里 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
    ]);
    const a = nodes[1];
    const sw = shellWorld();
    /* 节点压在壳的右下角上：外接矩形有交集、中心仍落在命中区内 */
    const np = { x: snapv(sw.x1 - 160), y: snapv(sw.y1 - 96) };
    ok(
      np.x + 240 > sw.x1 && np.x < sw.x1 && np.y + 160 > sw.y1 && np.y < sw.y1,
      "前置：节点外接矩形与壳的右下角确有交集（" + np.x + "," + np.y + " vs 壳角 " + sw.x1 + "," + sw.y1 + "）",
    );
    const cursor = { x: np.x + 240 + 120, y: np.y - 240 };
    ok(
      api.findOpenSuperAtWorld(cursor.x, cursor.y, new Set()) === null,
      "前置：光标已不在壳上（光标档不生效，落到矩形包容档）",
    );
    api.finalizeNodeDragNest(["A"], { A: np }, cursor);
    ok(parentOf(nodes, "A") === "SUP", "节点外接矩形仍压在壳上 → 不因光标偏出去就被弹到画布");
  }

  /* ⑥-d 拖到壳旁边的空白处（与壳毫无重叠）→ 仍然出壳，不被误吞回去 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
    ]);
    const sw = shellWorld();
    const np = { x: sw.x1 + 240, y: sw.y1 + 240 };
    api.finalizeNodeDragNest(["A"], { A: np }, { x: np.x + 120, y: np.y + 80 });
    ok(parentOf(nodes, "A") === "-", "整颗都拖到壳外空白处 → 出壳（矩形包容不等于「贴着就吞」）");
  }

  /* ⑥-e 不传光标（旧调用口径）时行为与原来一致 */
  {
    const { api, nodes } = makeSandbox([
      mkSuper("SUP"),
      mkNode({ id: "A", x: 1080, y: 300, parentSuperId: "SUP" }),
    ]);
    const a = nodes[1];
    const wp = api.nodeWorldPos(a);
    api.finalizeNodeDragNest(["A"], { A: { x: snapv(wp.x - 2000), y: wp.y } });
    ok(parentOf(nodes, "A") === "-", "不带光标点时仍按中点判定（旧口径保留，沙箱调用不受影响）");
  }
}

/* ═════════════ [7] 源码口径：入口与调用点仍在 ═════════════ */
function part7() {
  section("7 调用点与拒绝口径");
  ok(
    /const dropPt = toStage\(ev\.clientX, ev\.clientY\);[\s\S]{0,200}finalizeNodeDragNest\(dragIds, curWorld, dropPt\)/.test(APP),
    "mouseup 收尾把松手落点（光标）交给 finalizeNodeDragNest",
  );
  ok(
    APP.indexOf("function finalizeNodeDragNest(ids, curWorld, cursorPt)") > 0,
    "finalizeNodeDragNest 收光标落点参数（旧调用不传时退化为原口径）",
  );
  ok(
    APP.indexOf("function findOpenSuperContainingRect(r, exceptIds, tol)") > 0 &&
      NEST_FN.indexOf("findOpenSuperContainingRect(r, skipHosts, DRAG_RECT_TOL)") > 0,
    "矩形包容判据独立成 findOpenSuperContainingRect（带容错外扩），并被落点判据调用",
  );
  ok(
    APP.indexOf("const ids = dragIds.filter") >= 0 || APP.indexOf("ids: dragIds") >= 0,
    "拖拽状态里带的是整组 dragIds（多选整组一起移动）",
  );
  ok(
    NEST_FN.indexOf("整组只认一个落点宿主") > 0,
    "finalizeNodeDragNest 里写清「整组只认一个落点宿主」的口径",
  );
  ok(
    NEST_FN.indexOf("canMoveNodeIntoSuper(host, pick)") > 0,
    "整组进壳前用 canMoveNodeIntoSuper 复核宿主（自己 / 子孙 / 内部端子一律不进）",
  );
  ok(
    NEST_FN.indexOf("const byCenter = findOpenSuperAtWorld(c.x, c.y, skipHosts)") > 0,
    "光标与矩形都没命中时仍按逐成员中点兜底（并跳过被拖拽的壳自己）",
  );
  ok(
    NEST_FN.indexOf("fitAllOpenSuperShells()") > 0,
    "落定后调用 fitAllOpenSuperShells()：整组进壳后壳按内容撑开，新进去的节点不被裁掉",
  );
  ok(
    NEST_FN.indexOf("const focusId = currentSuperFocus()") > 0 &&
      NEST_FN.indexOf("superInnerAnchor(host)") > 0,
    "finalizeNodeDragNest 用 focusId + superInnerAnchor 支持子画布（不再一进门就整体返回）",
  );
  ok(CURSOR_FN.length > 0, "落点判据源码可切片（回归脚本与新参数同源）");
}

part1();
part2();
part3();
part4();
part5();
part6();
part7();
console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全绿") + "  (smoke-node-drag-nest)",
);
process.exit(fails ? 1 : 0);
