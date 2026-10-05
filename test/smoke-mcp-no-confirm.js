"use strict";
/* MCP 免确认 + 编辑不再自动改节点（2026-02 需求）—— 零依赖，node test/smoke-mcp-no-confirm.js
 * ============================================================================
 * 需求两句话：
 *   ① 「通过 MCP 越过权限审计」：MCP 连接开着 + 令牌对 = 全量读写，逐笔确认框 / 工具许可框
 *      一律不弹（口径见 guides/mcp-server.md §4；开关由 renderer/mcp-bridge.js 每帧置
 *      S._mcpAuthorized，帧结束立刻复原）。
 *   ② 「不要自动改变」：agent / MCP 的画布编辑只落内容与连线 —— 已存在节点的 w/h 不再被
 *      按正文长短重算，缺省也不再自动排版（唯一入口是本笔显式 layout:true）。
 *
 * 做法：把 renderer/app-nodes.js 里**真源码**的那几段抽出来，配最小假的宿主（document /
 * confirmDialog / I18n）在 vm 里真调一遍 —— 纯文本断言证明不了「授权期间真的不弹框」。
 *   [1] 已存在节点的尺寸：编辑路径不再重算（源码口径：sizeNodeForContent 只在 create 用一次）
 *   [2] 免确认：S._mcpAuthorized 期间 canvasOpNeedsConfirm / ensureAgentTool 都不弹框
 *   [3] 自动排版：只有显式 layout:true 才排（自动那一半已撤）
 *   [4] 新节点就近摆位：新节点不重叠、已有节点一个都不动、显式坐标原样保留
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const NODES = fs.readFileSync(path.join(ROOT, "renderer", "app-nodes.js"), "utf8");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function section(t) {
  console.log("\n" + t);
}
/** 按名字从源码里切出一段顶层 function（花括号配平；与其它冒烟同一套做法） */
function bodyOf(src, name) {
  const hit = "function " + name + "(";
  const at = src.indexOf(hit);
  if (at < 0) throw new Error("找不到函数：" + name);
  /* 保住 async（否则体里的 await 抽出来就成了语法错） */
  const asyncAt = src.slice(Math.max(0, at - 7), at);
  const head = /async\s$/.test(asyncAt) ? at - 6 : at;
  let i = src.indexOf("{", at);
  let depth = 0;
  for (let p = i; p < src.length; p++) {
    const ch = src[p];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(head, p + 1);
    }
  }
  throw new Error("花括号不配平：" + name);
}

/* ── 最小假的宿主（与真实全局同名同形，只做能用得上的那点事） ── */
function makeSandbox() {
  const notify = [];
  const S = {
    wf: { id: "wf-1", name: "测试画布", nodes: [], wires: [], marks: [], groups: [] },
    config: {},
    cam: { x: 0, y: 0, z: 1 },
    _mcpAuthorized: false,
  };
  const ctx = {
    S,
    notify,
    console,
    Math,
    JSON,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Infinity,
    NaN,
    isFinite,
    grid: () => 8,
    snap: (v) => Math.round(Number(v) / 8) * 8,
    snapDim: (v, m) => {
      const g = 8;
      const n = Math.round(Number(v) / g) * g;
      return Math.max(Number(m) || 0, n);
    },
    I18n: { t: (s) => String(s) },
    nodeById: (id) => (S.wf.nodes || []).find((n) => n.id === id) || null,
    nodeDrawSize: (n) =>
      n && n.kind === "super" && n.superOpen
        ? {
            w: Math.max(320, Number(n.expandW) || 720),
            h: Math.max(220, Number(n.expandH) || 480),
          }
        : { w: (n && n.w) || 288, h: (n && n.h) || 192 },
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
    isSuperIoNode: (n) => !!(n && n.superIo),
    isExecStart: (n) => !!(n && n.ctrlRole === "start"),
    isExecEnd: (n) => !!(n && n.ctrlRole && n.ctrlRole !== "start"),
    isSaveNode: (n) => !!(n && String(n.kind).indexOf("save") >= 0),
    isSaveKind: (k) => String(k || "").indexOf("save") >= 0,
    saveMediaKind: () => "",
    NODE_DEFAULTS: {
      input_text: { title: "文本", w: 240, h: 140 },
      proc_text: { title: "处理", w: 320, h: 220 },
      save: { title: "保存", w: 240, h: 160 },
    },
    /* 弹框 / 提示一律记账：真调到了就是「MCP 期间还弹了框」 */
    confirmDialog: () => {
      notify.push("confirmDialog");
      return Promise.resolve(true);
    },
    toast: (m) => notify.push("toast:" + String(m)),
    anyAgentSessionRunning: () => false,
    currentVisibleWf: () => S.wf,
    /* 工具许可三件套的桩：default 档 = ask，只有 MCP 授权那一条短路能让它不弹框 */
    agentToolMode: () => "ask",
    agentToolItemLabel: (k) => String(k),
    canvasToolAskBypassed: () => false,
    agentToolCatalog: () => [
      { id: "canvas", items: [{ key: "canvas_nodes", label: "节点与连线" }] },
    ],
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

const FNS = [
  "rectsOverlap",
  "layoutGap",
  "layoutSnapSized",
  "layoutSnapSize",
  "layoutNodeSize",
  "nodePlacementObstacles",
  "freeSpotForNode",
  "applyNewNodePlacement",
  "canvasEditWantsLayout",
  "canvasOpNeedsConfirm",
  "sizeNodeForContent",
  "ensureAgentTool",
];

/** 去注释：断言源码时不该被说明文字里的示例调用带偏 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function loadInto(ctx) {
  const src = FNS.map((n) => bodyOf(NODES, n)).join("\n\n");
  vm.runInContext(src, ctx, { filename: "app-nodes-extract.js" });
}

/* ══════════════════════ [1] 已存在节点的尺寸不再被重算 ══════════════════════ */
function part1() {
  section("[1] 编辑不再自动改已存在节点的 w/h");
  const at = NODES.indexOf("async function applyCanvasEdit(");
  ok(at > 0, "app-nodes.js 里能找到 applyCanvasEdit");
  const body = stripComments(bodyOf(NODES, "applyCanvasEdit"));
  const calls = (body.match(/sizeNodeForContent\(node\);/g) || []).length;
  ok(
    calls === 1,
    "applyCanvasEdit 里 sizeNodeForContent 只调 1 次（只在 create 那次；实际 " + calls + " 次）",
  );
  const createAt = body.indexOf("sizeNodeForContent(node);");
  const updAt = body.indexOf("for (const spec of updates) {");
  ok(
    createAt > 0 && updAt > createAt,
    "那唯一一次落在 update 循环之前（= 只给新建节点，不碰已存在节点）",
  );
  ok(
    bodyOf(NODES, "applyCanvasEdit").indexOf("已存在节点的尺寸不再被自动重算") > 0,
    "update 侧留着「已存在节点的尺寸不再被自动重算」的说明（口径可追溯）",
  );
  ok(
    /node\.h = Math\.max\(d\.h, d\.h \+ extra\);/.test(NODES),
    "sizeNodeForContent 本体仍在（新建节点仍给美观尺寸，只是不再从编辑路径调它）",
  );
}

/* ══════════════════════ [2] MCP 免确认 ══════════════════════ */
function part2() {
  section("[2] MCP 连接期间：画布确认框与工具许可框一律不弹");
  const ctx = makeSandbox();
  loadInto(ctx);
  const run = (expr) => vm.runInContext(expr, ctx);

  ctx.S.assistRunActive = true; /* 最严条件：自家会话正在跑，本该逐笔确认 */
  ctx.S._mcpAuthorized = false;
  ok(
    run('canvasOpNeedsConfirm("edit", {})') === true,
    "对照：没有 MCP 授权时，会话在跑 → edit 要确认（说明这段逻辑真的在跑）",
  );
  ok(
    run('canvasOpNeedsConfirm("app", { action: "delete_workflow" })') === true,
    "对照：删画布同样要确认",
  );

  ctx.S._mcpAuthorized = true;
  const cases = [
    ['canvasOpNeedsConfirm("edit", {})', "edit（建图 / 改节点 / 连线）"],
    ['canvasOpNeedsConfirm("app", { action: "delete_workflow" })', "app：删画布"],
    ['canvasOpNeedsConfirm("app", { action: "install_dsh_plugin" })', "app：装 DSH 插件"],
    ['canvasOpNeedsConfirm("get", {})', "get（只读）"],
    ['canvasOpNeedsConfirm("vision", {})', "vision（识图）"],
  ];
  let allFalse = true;
  for (const [expr, label] of cases) {
    if (run(expr) !== false) allFalse = false;
  }
  ok(allFalse, "MCP 授权期间：6 类 op 的确认判定全为 false（不弹确认框）");

  const before = ctx.notify.length;
  run('ensureAgentTool("canvas_nodes")');
  run('ensureAgentTool("canvas_read")');
  run('ensureAgentTool("app_ops")');
  ok(
    ctx.notify.length === before,
    "ensureAgentTool 在 MCP 授权期间不弹工具许可框（也不抛拒绝）",
  );

  /* 授权只在帧内有效：关掉开关后旧行为立刻回来（绝不常驻） */
  ctx.S._mcpAuthorized = false;
  ok(
    run('canvasOpNeedsConfirm("edit", {})') === true,
    "帧结束（S._mcpAuthorized 复原）后，确认判定回到原来的 true",
  );
}

/* ══════════════════════ [3] 自动排版只剩显式入口 ══════════════════════ */
function part3() {
  section("[3] 编辑缺省不再自动排版");
  const ctx = makeSandbox();
  loadInto(ctx);
  const wants = (p, c) => vm.runInContext("canvasEditWantsLayout", ctx)(p, c);
  ok(wants({ create: [{ alias: "a", kind: "input_text" }] }, [{}]) === false, "建图 → 不排版");
  ok(wants({ connect: [{ from: "a", to: "b" }] }, []) === false, "连线 → 不排版");
  ok(wants({ remove: ["x"] }, []) === false, "删节点 → 不排版");
  ok(wants({ createMarks: [{ kind: "box" }] }, []) === false, "加标注 → 不排版");
  ok(wants({ update: [{ w: 400 }] }, []) === false, "改尺寸 → 不排版");
  ok(wants({ group: { title: "g" } }, []) === false, "成组 → 不排版");
  ok(wants({ layout: true }, []) === true, "显式 layout:true → 照排（唯一入口）");
  const body = bodyOf(NODES, "applyCanvasEdit");
  ok(
    body.indexOf("const doLayout = wantsLayout;") > 0,
    "applyCanvasEdit 里的 doLayout 只认那个闸（不再 or 上「自动那一半」）",
  );
}

/* ══════════════════════ [4] 新节点就近摆位 ══════════════════════ */
function part4() {
  section("[4] 新节点就近找空位：已有节点一个都不动");
  const ctx = makeSandbox();
  loadInto(ctx);
  const S = ctx.S;
  const old = {
    id: "old1",
    kind: "input_text",
    title: "老节点",
    x: 64,
    y: 64,
    w: 240,
    h: 160,
    parentSuperId: "",
    parentTaskId: "",
  };
  S.wf.nodes = [old];
  const fresh = {
    id: "new1",
    kind: "input_text",
    title: "新节点",
    x: 48,
    y: 48,
    w: 240,
    h: 160,
    parentSuperId: "",
    parentTaskId: "",
  };
  S.wf.nodes.push(fresh);
  const placement = vm.runInContext("applyNewNodePlacement", ctx);
  placement([fresh], { origin: { x: 48, y: 48 }, pinned: new Set(), outOfScope: () => false });

  ok(
    vm.runInContext("rectsOverlap", ctx)(
      { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h },
      { x: old.x, y: old.y, w: old.w, h: old.h },
      0,
    ) === false,
    "新节点落点与已有节点不重叠（就近找空位，实际 " + fresh.x + "/" + fresh.y + "）",
  );
  ok(
    old.x === 64 && old.y === 64 && old.w === 240 && old.h === 160,
    "已有节点的 x/y/w/h 全部原样（一个都不动）",
  );
  ok(
    fresh.w === 240 && fresh.h === 160,
    "摆位只改位置、不改新节点尺寸",
  );

  /* 显式给了坐标的新节点：坐标是调用方钉的，摆位跳过它 */
  const pinNode = {
    id: "new2",
    kind: "input_text",
    title: "定点节点",
    x: 64,
    y: 64,
    w: 240,
    h: 160,
    parentSuperId: "",
    parentTaskId: "",
  };
  S.wf.nodes.push(pinNode);
  placement([pinNode], {
    origin: { x: 48, y: 48 },
    pinned: new Set(["new2"]),
    outOfScope: () => false,
  });
  ok(
    pinNode.x === 64 && pinNode.y === 64,
    "本笔显式给了 x/y 的新节点不被挪（pinned 跳过）",
  );

  /* scope 界外的新节点不摆（与其余写入闸同口径） */
  const outNode = {
    id: "new3",
    kind: "input_text",
    title: "界外节点",
    x: 48,
    y: 48,
    w: 240,
    h: 160,
    parentSuperId: "",
    parentTaskId: "",
  };
  S.wf.nodes.push(outNode);
  placement([outNode], {
    origin: { x: 48, y: 48 },
    pinned: new Set(),
    outOfScope: () => true,
  });
  ok(outNode.x === 48 && outNode.y === 48, "scope 界外的新节点保持原样（摆位跳过）");

  /* 空画布：落点就是原点，不外扩 */
  S.wf.nodes = [];
  const free = vm.runInContext("freeSpotForNode", ctx)(
    { id: "a", kind: "input_text", x: 0, y: 0, w: 240, h: 160 },
    { x: 48, y: 48 },
    [],
  );
  ok(free.x === 48 && free.y === 48, "空画布落点 = 原点 48/48（不无谓外扩）");
}

part1();
part2();
part3();
part4();

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
