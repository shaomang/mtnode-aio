"use strict";
/* 顶栏「超节点」二次点击 = 拆开普通超级节点 —— 冒烟测试
 * （纯 Node：app.js 的真实源码切片进 vm 真跑，不启动 Electron、不碰 %APPDATA%）
 *   node test/smoke-super-unwrap.js
 *
 * 需求：选中单个普通超级节点时，再点一次顶栏「超节点」按钮，应把
 *   ① 壳内全部内容（节点 + 壳内绘制）按**原本位置关系**移回外层，
 *   ② 再删除这颗已空的超级节点。
 *
 * 覆盖：
 *   [1] 入口分叉：只选中一颗普通超级节点 → 拆壳；其余情况仍走「框选合并」
 *   [2] 位置换算：根层拆壳后内容停在原处、相对关系不变、连线保留
 *   [3] 嵌套展开壳内 / 全屏进入态：拆前拆后「看得见的位置」一致
 *   [4] 空壳照样删；开发 / 数据库 / 工具节点壳与多选不接管
 *   [5] 接线与词条：index.html tooltip、app-boot 点击入口、i18n 中英齐备
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

const APP = read("renderer/app.js");
const BOOT = read("renderer/app-boot.js");
const HTML = read("renderer/index.html");

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

/* ---------- 从 app.js 切出真实函数源码（从 startMark 起按大括号配平到函数结束） ---------- */
function fnSrc(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) {
    ok(false, "定位到源码：" + label);
    return "";
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  let j = open;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(i, j + 1);
}

const SRC = {
  worldPos: fnSrc(APP, "function nodeWorldPos(n, _seen) {", "nodeWorldPos"),
  nested: fnSrc(APP, "function nodeIsNestedInOpenSuper(n) {", "nodeIsNestedInOpenSuper"),
  displaySize: fnSrc(APP, "function superDisplaySize(n) {", "superDisplaySize"),
  innerOrigin: fnSrc(APP, "function superInnerOrigin(s) {", "superInnerOrigin"),
  innerPan: fnSrc(APP, "function superInnerPan(s) {", "superInnerPan"),
  innerAnchor: fnSrc(APP, "function superInnerAnchor(s) {", "superInnerAnchor"),
  openShell: fnSrc(APP, "function superIsOpenShell(n) {", "superIsOpenShell"),
  curSuper: fnSrc(APP, "function currentSuperFocus() {", "currentSuperFocus"),
  parentSuper: fnSrc(APP, "function nodeParentSuperId(n) {", "nodeParentSuperId"),
  parentTask: fnSrc(APP, "function nodeParentTaskId(n) {", "nodeParentTaskId"),
  markParentSuper: fnSrc(APP, "function markParentSuperId(m) {", "markParentSuperId"),
  snap: fnSrc(APP, "function snap(v) {", "snap"),
  grid: fnSrc(APP, "function grid() {", "grid"),
  isTool: fnSrc(APP, "function isToolNode(n) {", "isToolNode"),
  plainSuper: fnSrc(APP, "function plainSuperForUnwrap() {", "plainSuperForUnwrap"),
  onWrapBtn: fnSrc(APP, "function onWrapSuperButton() {", "onWrapSuperButton"),
  stageToLocal: fnSrc(APP, "function outerLocalTarget(x, y, hostSuperId) {", "outerLocalTarget"),
  unwrap: fnSrc(APP, "async function unwrapSuperToOuter(host) {", "unwrapSuperToOuter"),
};
const REAL_FNS = Object.keys(SRC)
  .map((k) => SRC[k])
  .join("\n");
ok(
  REAL_FNS.indexOf("function nodeWorldPos") >= 0 &&
    REAL_FNS.indexOf("async function unwrapSuperToOuter") >= 0 &&
    REAL_FNS.indexOf("function plainSuperForUnwrap") >= 0 &&
    REAL_FNS.indexOf("function outerLocalTarget") >= 0,
  "切出全部真实源码段（坐标换算 + 入口分叉 + 拆壳）",
);

/* 最小宿主：只补这次真跑会用到的依赖（取值口径与真实实现一致） */
const HOST = `
var S = __S__;
var host = __HOST__;
function nodeById(id){ var ws=(S.wf&&S.wf.nodes)||[]; for (var i=0;i<ws.length;i++) if (ws[i].id===id) return ws[i]; return null; }
function isSuperIoNode(n){ return !!(n && n.kind === "super_io"); }
function isSuperLikeNode(n){ return !!(n && (n.kind === "super" || n.tool)); }
function selNodes(){ return S.selSet ? Array.from(S.selSet).map(nodeById).filter(Boolean) : []; }
function setSuperFocus(id){ S.superFocus = id || ""; host.focusCalls.push(id || ""); }
function nodesBBox(list){
  var xs=[], ys=[];
  (list||[]).forEach(function(n){ xs.push(n.x); ys.push(n.y);
    var sz = n.kind==="super" ? superDisplaySize(n) : { w:(n.w||240), h:(n.h||160) };
    xs.push(n.x+sz.w); ys.push(n.y+sz.h); });
  if (!xs.length) return null;
  return { minX: Math.min.apply(null,xs), minY: Math.min.apply(null,ys),
           maxX: Math.max.apply(null,xs), maxY: Math.max.apply(null,ys) };
}
function pushHistory(){ host.history++; }
function renderCanvas(){ host.renders++; }
function scheduleSave(){ host.saves++; }
function renderStatus(){ host.status++; }
function toast(msg){ host.toasts.push(msg); }
function deleteNodes(ids){ return host.deleteNodes(ids); }
function captureMarkBindings(){ return host.bindings || []; }
function rebindMarksAfterLayout(){ host.rebinds++; }
var I18n = { t: function(k){ return k; } };
`;

/* 删壳：与真实 deleteNodes 的删后结果一致（壳 + 内部后代 + 壳内绘制一并去，穿过壳的线一起清） */
function fakeDelete(S, host) {
  return function (ids) {
    const set = new Set(ids);
    host.deleted.push(...ids);
    for (let pass = 0; pass < 4; pass++) {
      for (const n of S.wf.nodes) {
        if (!set.has(n.id) && n.parentSuperId && set.has(n.parentSuperId)) {
          set.add(n.id);
          host.deleted.push(n.id);
        }
      }
    }
    host.deleted.push(
      ...(S.wf.marks || []).filter((m) => set.has(m.parentSuperId)).map((m) => m.id),
    );
    S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
    S.wf.marks = (S.wf.marks || []).filter((m) => !set.has(m.parentSuperId));
    S.wf.wires = (S.wf.wires || []).filter((w) => !set.has(w.from) && !set.has(w.to));
    return true;
  };
}

function mkCtx(state, bindings) {
  const host = {
    bindings: bindings || [],
    deleted: [],
    focusCalls: [],
    history: 0,
    rebinds: 0,
    renders: 0,
    saves: 0,
    status: 0,
    toasts: [],
  };
  host.deleteNodes = fakeDelete(state, host);
  const ctx = {
    __S__: state,
    __HOST__: host,
    console,
    Math,
    Promise,
    MTNODE_DEBUG_UNWRAP: !!process.env.MTNODE_DEBUG,
    /* 真实壳层原点要量 DOM；测试里没有 DOM → 走 superInnerOrigin 自己的回落口径（折叠 10/40、展开 0/29） */
    document: { querySelector: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(HOST + "\n" + REAL_FNS, ctx, { filename: "app.js#super-unwrap" });
  ctx.__hostRef = host;
  return ctx;
}
const N = (state, id) => state.wf.nodes.filter((n) => n.id === id)[0];

(async function main() {
  /* ==================== [1] 入口分叉 ==================== */
  console.log("\n[1] 入口分叉：只选中一颗普通超级节点 → 拆壳；否则仍走框选合并");
  {
    const state = {
      wf: { nodes: [{ id: "h", kind: "super" }], marks: [], wires: [] },
      selSet: new Set(["h"]),
      superFocus: "",
    };
    const t = mkCtx(state);
    ok(t.plainSuperForUnwrap() === N(state, "h"), "单选中普通超节点 → 认得它");
    ok(typeof t.onWrapSuperButton === "function", "onWrapSuperButton 可就地调用");
    ok(
      BOOT.indexOf("onWrapSuperButton()") >= 0 &&
        BOOT.indexOf("wrapSelectionAsSuper();") < 0,
      "app-boot.js：#btnWrapSuper 点击走 onWrapSuperButton（不再直接框选合并）",
    );
    ok(
      APP.indexOf('I18n.t("拆开超节点：内容原样移回外层，并删除这颗空壳")') >= 0,
      "syncGroupBtns：单选中超节点时按钮提示切到「拆开超节点」",
    );
    ok(
      APP.indexOf("const unwrap = plainSuperForUnwrap();") >= 0 &&
        APP.indexOf('bs.classList.toggle("on", !!unwrap || canWrap)') >= 0,
      "syncGroupBtns：按钮高亮 / 禁用随 unwrap 判定同步",
    );
  }

  /* ==================== [2] 根层：内容停在原处 ==================== */
  console.log("\n[2] 根层拆壳：内容停在原处，相对关系不变，连线保留");
  {
    const state = {
      wf: {
        nodes: [
          {
            id: "host", kind: "super", x: 100, y: 200, w: 280, h: 200, parentSuperId: "",
            superOpen: true, expandW: 700, expandH: 500,
          },
          { id: "c1", kind: "proc_text", x: 10, y: 30, parentSuperId: "host" },
          { id: "c2", kind: "input_text", x: 210, y: 130, parentSuperId: "host" },
        ],
        marks: [],
        wires: [{ from: "c1", to: "c2" }],
      },
      selSet: new Set(["host"]),
      superFocus: "",
    };
    const t = mkCtx(state);
    /* 壳展开：孩子以「壳层原点 + 本地坐标」展示，先在拆前记下它们的可见世界坐标 */
    const b1 = t.nodeWorldPos(N(state, "c1"));
    const b2 = t.nodeWorldPos(N(state, "c2"));
    await t.unwrapSuperToOuter(N(state, "host"));
    ok(N(state, "host") === undefined, "空壳已删除");
    const a1 = t.nodeWorldPos(N(state, "c1"));
    const a2 = t.nodeWorldPos(N(state, "c2"));
    if (process.env.MTNODE_DEBUG)
      console.log("  DEBUG", JSON.stringify({ b1, b2, a1, a2, n1: N(state, "c1"), n2: N(state, "c2") }));
    ok(
      Math.abs(a1.x - b1.x) < 0.001 && Math.abs(a1.y - b1.y) < 0.001,
      "展开壳：c1 停在原处（世界坐标不变）",
    );
    ok(
      Math.abs(a2.x - b2.x) < 0.001 && Math.abs(a2.y - b2.y) < 0.001,
      "展开壳：c2 停在原处（世界坐标不变）",
    );
    ok(
      Math.abs(a2.x - a1.x - (b2.x - b1.x)) < 0.001 &&
        Math.abs(a2.y - a1.y - (b2.y - b1.y)) < 0.001,
      "内容之间的相对位置关系不变",
    );
    ok(
      N(state, "c1").parentSuperId === "" && N(state, "c2").parentSuperId === "",
      "parentSuperId 落回外层",
    );
    ok(
      N(state, "c1").parentTaskId === "" && N(state, "c2").parentTaskId === "",
      "parentTaskId 随外层（根层为空）",
    );
    ok(state.wf.wires.length === 1 && state.wf.wires[0].from === "c1", "两端都在壳内的连线原样保留");
    ok(t.__hostRef.toasts.length === 1 && /拆开超节点/.test(t.__hostRef.toasts[0]), "收尾有明确提示");
    ok(t.__hostRef.history === 1, "拆壳前记一次历史（可撤销）");
  }

  /* ==================== [3] 嵌套展开壳内 + 全屏进入态 ==================== */
  console.log("\n[3] 嵌套展开壳内 / 全屏进入态：拆前拆后「看得见的位置」一致");
  {
    const state = {
      wf: {
        nodes: [
          {
            id: "A", kind: "super", x: 50, y: 50, w: 800, h: 600, superOpen: true,
            expandW: 800, expandH: 600, parentSuperId: "",
          },
          {
            id: "B", kind: "super", x: 100, y: 80, parentSuperId: "A", superOpen: true,
            expandW: 700, expandH: 500,
          },
          { id: "C", kind: "proc_text", x: 20, y: 40, parentSuperId: "B" },
          { id: "D", kind: "proc_text", x: 320, y: 140, parentSuperId: "B" },
        ],
        marks: [],
        wires: [{ from: "C", to: "D" }],
      },
      selSet: new Set(["B"]),
      superFocus: "",
    };
    const t = mkCtx(state);
    const bC = t.nodeWorldPos(N(state, "C"));
    const bD = t.nodeWorldPos(N(state, "D"));
    await t.unwrapSuperToOuter(N(state, "B"));
    ok(N(state, "B") === undefined, "嵌套壳 B 被删除");
    const aC = t.nodeWorldPos(N(state, "C"));
    const aD = t.nodeWorldPos(N(state, "D"));
    if (process.env.MTNODE_DEBUG)
      console.log(
        "  DEBUG3",
        JSON.stringify({ bC, bD, aC, aD, nC: N(state, "C"), nD: N(state, "D") }),
      );
    /* 跨壳要换算坐标系，落位允许「整组吸网格」的同一差值（≤ 半格 = 12px），
       但必须是**整组同一个差值**：两个孩子的位移向量相等 → 相对位置关系一点没变。 */
    const dC = { x: aC.x - bC.x, y: aC.y - bC.y };
    const dD = { x: aD.x - bD.x, y: aD.y - bD.y };
    ok(
      Math.abs(dC.x) <= 12 && Math.abs(dC.y) <= 12 && Math.abs(dD.x) <= 12 && Math.abs(dD.y) <= 12,
      "嵌套展开壳内：C / D 都停在原处（位移不超过半格）",
    );
    ok(
      dC.x === dD.x && dC.y === dD.y,
      "嵌套展开壳内：整组同一个差值（组内相对距离完全不变）",
    );
    ok(
      Math.abs(aD.x - aC.x - (bD.x - bC.x)) < 0.001 &&
        Math.abs(aD.y - aC.y - (bD.y - bC.y)) < 0.001,
      "嵌套展开壳内：拆前拆后 C→D 的相对位置关系不变",
    );
    ok(N(state, "C").parentSuperId === "A" && N(state, "D").parentSuperId === "A", "内容改挂到外层壳 A");
    ok(state.wf.wires.length === 1, "内部连线保留（两端都还在）");
  }
  {
    /* 全屏进入态：正停在壳里点按钮（children 以舞台坐标展示） */
    const state = {
      wf: {
        nodes: [
          { id: "host", kind: "super", x: 30, y: 60, parentSuperId: "", superOpen: false },
          { id: "k1", kind: "proc_text", x: 12, y: 34, parentSuperId: "host" },
          { id: "k2", kind: "proc_text", x: 312, y: 234, parentSuperId: "host" },
        ],
        marks: [],
        wires: [],
      },
      selSet: new Set(["host"]),
      superFocus: "host",
    };
    const t = mkCtx(state);
    const b1 = t.nodeWorldPos(N(state, "k1"));
    await t.unwrapSuperToOuter(N(state, "host"));
    const a1 = t.nodeWorldPos(N(state, "k1"));
    ok(
      Math.abs(a1.x - b1.x) < 0.001 && Math.abs(a1.y - b1.y) < 0.001,
      "全屏进入态点按钮：内容仍停在原处（舞台坐标不回跳）",
    );
    ok(state.superFocus === "", "focus 从被删的壳退回外层（根层 = 空）");
    ok(
      t.__hostRef.focusCalls[t.__hostRef.focusCalls.length - 1] === "",
      "setSuperFocus 收到外层 id（根层 = 空串）",
    );
  }

  /* ==================== [4] 空壳照样删；其它壳 / 多选不接管 ==================== */
  console.log("\n[4] 空壳照样删；开发 / 数据库 / 工具节点壳与多选不接管");
  {
    const state = {
      wf: {
        nodes: [{ id: "host", kind: "super", x: 10, y: 10, parentSuperId: "" }],
        marks: [],
        wires: [],
      },
      selSet: new Set(["host"]),
      superFocus: "",
    };
    const t = mkCtx(state);
    await t.unwrapSuperToOuter(N(state, "host"));
    ok(N(state, "host") === undefined, "内部一个节点都没有也照样把空壳删掉");
  }
  {
    const state = {
      wf: {
        nodes: [
          { id: "d", kind: "super", dev: true },
          { id: "b", kind: "super", db: true },
          { id: "t", kind: "super", tool: true },
        ],
        marks: [],
        wires: [],
      },
      selSet: new Set(["d"]),
      superFocus: "",
    };
    const t = mkCtx(state);
    ["d", "b", "t"].forEach((id) => {
      state.selSet = new Set([id]);
      ok(t.plainSuperForUnwrap() === null, "「" + id + "」这类壳不接管二次点击");
    });
    state.selSet = new Set(["d", "b"]);
    ok(t.plainSuperForUnwrap() === null, "多选（不止一颗）不接管");
    state.selSet = new Set();
    ok(t.plainSuperForUnwrap() === null, "空选不接管");
  }

  /* ==================== [5] 接线与词条 ==================== */
  console.log("\n[5] 接线与词条：index.html / app-boot / i18n");
  {
    const I18n = require("../renderer/i18n.js");
    const keys = [
      "拆开超节点：内容原样移回外层，并删除这颗空壳",
      "已拆开超节点：",
      "移出 ",
      " 项内部绘制",
      "清理 ",
      "超节点：将选中节点合并为展开的超级节点（覆盖选区范围）；选中单个超级节点时再点一次 = 拆开它（内容原样移回外层，空壳删除）",
    ];
    I18n.setLocale("en");
    const missing = keys.filter((k) => I18n.t(k) === k);
    ok(missing.length === 0, "新增词条中英齐备，缺：" + (missing.join(" / ") || "无"));
    ok(
      HTML.indexOf("选中单个超级节点时再点一次 = 拆开它") >= 0,
      "index.html：#btnWrapSuper 的 tooltip 写明二次点击 = 拆开",
    );
    ok(
      !/data-i18n-title="超节点：将选中节点合并为展开的超级节点（覆盖选区范围）"/.test(HTML),
      "旧的「只讲合并」tooltip 已替换（无残留）",
    );
  }

  console.log(
    "\n" + (fails ? "FAIL " + fails + " / " : "OK ") + checks + " 项检查" + (fails ? "" : "全绿"),
  );
  process.exit(fails ? 1 : 0);
})();
