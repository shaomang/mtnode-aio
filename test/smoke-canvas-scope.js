"use strict";
/* 局部画布（scope）回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-canvas-scope.js
 *
 * 本轮需求：画布查看 / 编辑工具原先一次只看一次改「用户当前所在的那一层整图」，
 * 钻超级 / 开发节点内部时又要把整张图灌进上下文。本测试钉住新加的局部口径：
 *   [1] 只读侧：canvasSnapshot({scope, scopeDepth}) 只回某一颗壳内部 ——
 *       节点 / 连线 / 绘制 / 分组 / 任务树 / 超级树全部收窄，scopeInfo 说明范围与祖先；
 *       [2] 默认仍是整图（不静默收窄别的消费者），但 scopeInfo.hint 会点名用户当前
 *           停留的壳，Agent 据此显式传 scope；
 *   [3] 写入侧：applyCanvasEdit 的 scope 闸 —— 界外节点 / 绘制 / 连线 / 成组 / 排版
 *       一律跳过 + warnings，壳内 create 缺 parentSuperId 时默认落进 scope 那颗壳；
 *   [4] 工具描述与 i18n：canvas_get / canvas_edit 的参数表与说明写清 scope 口径，
 *       新增中文串中英成对（否则英文界面下会漏出中文）。
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

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
const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);

const NODES = read("renderer/app-nodes.js");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const HTML = read("renderer/index.html");
const ZH = read("renderer/i18n.js");

/* 端子数固定的节点名单（快照在 standard / full 档给 ports）：从源码抽，测试不另抄一份 */
const SNAPSHOT_PORT_KINDS = (() => {
  const m = NODES.match(/const SNAPSHOT_PORT_KINDS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
/* minimal 档的字段白名单（pruneNodeSnap 用）：同样从源码抽 */
const NODE_MINIMAL_KEYS = (() => {
  const m = NODES.match(/const NODE_MINIMAL_KEYS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
/* minimal 档保留的重型块与要摘掉的恒带小上下文：同样从源码抽，测试不另抄一份 */
const MINIMAL_SNAPSHOT_SECTIONS = (() => {
  const m = NODES.match(/const MINIMAL_SNAPSHOT_SECTIONS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
const MINIMAL_SNAPSHOT_DROP = (() => {
  const m = NODES.match(/const MINIMAL_SNAPSHOT_DROP\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
/* 重型块名单（pruneMinimalSnapshot / applySnapshotSectionFilter 共用）：同样从源码抽 */
const SNAPSHOT_HEAVY_SECTIONS = (() => {
  const m = NODES.match(/const SNAPSHOT_HEAVY_SECTIONS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
/* 正文键（standard 档只留 *Len 用）：同样从源码抽 */
const NODE_BODY_KEYS = (() => {
  const m = NODES.match(/const NODE_BODY_KEYS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();
/* 端子随连线增量涨的类别名单（snapshotInputGrowsWithWires 用）：同样从源码抽 */
const INCREMENTAL_PORT_KINDS = (() => {
  const m = NODES.match(/const INCREMENTAL_PORT_KINDS\s*=\s*\[[^\]]*\]/);
  return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
})();

/* ── 把 app-nodes.js 的 scope 一段抠出来放进沙箱（跑真函数，不读字面量）── */
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

/* 迷你画布：一颗开发壳 dev（含 file 子块 f1 → 孙块 g1）、一颗兄弟壳 sib、一个顶层节点 top */
const GRAPH = [
  { id: "dev", kind: "super", dev: true, devKind: "module", title: "开发壳", x: 0, y: 0, w: 400, h: 300, superOpen: true },
  { id: "f1", kind: "super", dev: true, devKind: "file", title: "文件块", parentSuperId: "dev", x: 20, y: 40, w: 240, h: 160, superOpen: true },
  { id: "g1", kind: "proc_text", title: "孙节点", parentSuperId: "f1", x: 30, y: 60, w: 200, h: 120, prompt: "p1" },
  { id: "sib", kind: "super", title: "兄弟壳", x: 600, y: 0, w: 300, h: 200 },
  { id: "sibkid", kind: "proc_text", title: "兄弟内", parentSuperId: "sib", x: 620, y: 40, w: 200, h: 120 },
  { id: "top", kind: "proc_text", title: "顶层节点", x: 0, y: 500, w: 200, h: 120 },
];
const WIRES = [
  { id: "w1", from: "g1", to: "f1" },
  { id: "w2", from: "sibkid", to: "sib" },
];
const MARKS = [
  { id: "m1", kind: "box", x: 10, y: 10, w: 200, h: 100, parentSuperId: "dev" },
  { id: "m2", kind: "box", x: 620, y: 10, w: 200, h: 100, parentSuperId: "sib" },
];
const GROUPS = [
  { id: "gr1", title: "壳内组", nodeIds: ["dev", "f1"], markIds: [] },
  { id: "gr2", title: "跨壳组", nodeIds: ["sib", "top"], markIds: [] },
];

function makeSandbox(focus) {
  const nodes = GRAPH.map((n) => Object.assign({}, n));
  const byId = (id) =>
    nodes.filter((n) => n.id === id || n.title === id)[0] || null;
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
    I18n: {
      t: (k, vars) => {
        let s = I18n.t(k);
        if (vars && typeof vars === "object")
          s = s.replace(/\{(\w+)\}/g, (_, kk) => (vars[kk] == null ? "" : String(vars[kk])));
        return s;
      },
    },
    S: {
      wf: { id: "wf1", name: "测试画布", nodes, wires: WIRES.slice(), marks: MARKS.slice(), groups: GROUPS.map((g) => Object.assign({}, g)) },
      view: "workflow",
      cam: { x: 0, y: 0, z: 1 },
      superFocus: focus || "",
    },
    IMAGE_SIZES: ["auto"],
    DEFAULT_IMAGE_SIZE: "auto",
    NODE_DEFAULTS: { proc_text: { title: "文本", w: 240, h: 160 } },
    MARK_COLORS: ["#ffffff"],
    /* 端子表推导（nodePortList → editPortNameOf / editPortKindOf）的依赖：本测试只关心
       scope 收窄，数量 / 类型按最小可用口径给桩，端口命名仍跑真源码。 */
    SNAPSHOT_PORT_KINDS,
    NODE_MINIMAL_KEYS,
    MINIMAL_SNAPSHOT_SECTIONS,
    MINIMAL_SNAPSHOT_DROP,
    SNAPSHOT_HEAVY_SECTIONS,
    NODE_BODY_KEYS,
    INCREMENTAL_PORT_KINDS,
    inputCount: (n) => (n && n.kind === "super" ? 2 : 1),
    outputCount: () => 1,
    isFnToolNode: () => false,
    isControlKind: () => false,
    /* 素材节点（kind "asset"）：本测试不含它，但快照序列化段现在会问它 —— 给最小可用桩 */
    isAssetNode: () => false,
    assetItems: () => [],
    assetPortKind: () => null,
    snapshotAssetNodeOf: () => undefined,
    assetItemViewGet: () => null,
    assetItemViewLoaded: () => null,
    fnToolPortKind: () => "any",
    nodeById: byId,
    /* snapshotPortsOf → snapshotInputGrowsWithWires 的依赖（端子增量口径与 app.js allWiresTo 同口径） */
    allWiresTo: (id) =>
      (sb.S.wf.wires || []).filter((w) => w.to === id && !w.rel).sort((a, b) => a.toIndex - b.toIndex),
    isSuperIoNode: (n) => !!(n && n.kind === "super_io"),
    superDisplaySize: (n) => ({ w: n.w || 280, h: n.h || 200 }),
    nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    currentTaskFocus: () => "",
    currentSuperFocus: () => sb.S.superFocus || "",
    nodeInCurrentScope: (n) => {
      if (!n) return false;
      const sf = sb.currentSuperFocus();
      if (sf) return sb.nodeParentSuperId(n) === sf;
      /* 根画布：只有顶层节点在范围内；子块要每一层宿主都是展开态（与 app.js 真源同口径） */
      let sid = sb.nodeParentSuperId(n);
      if (!sid) return true;
      const seen = new Set();
      while (sid && !seen.has(sid)) {
        seen.add(sid);
        const host = sb.nodeById(sid);
        if (!host || host.kind !== "super" || !host.superOpen) return false;
        sid = sb.nodeParentSuperId(host);
      }
      return true;
    },
    markInCurrentScope: (m) => {
      if (!m) return false;
      const sf = sb.currentSuperFocus();
      if (sf) return ((m && m.parentSuperId) || "") === sf;
      return !(m && m.parentSuperId);
    },
    wfTagCatalog: () => [],
    devFuncColorCatalog: () => [],
    normalizeNodeTags: () => [],
    canUseGlobalRefs: () => false,
    isFunctionNode: () => false,
    isNetNode: () => false,
    isToolNode: () => false,
    isCustomVideoGen: () => false,
    isVideoPostKind: () => false,
    devKindOf: (n) => (n && n.devKind) || "module",
    devColorOf: () => "",
    devCoreFilesOf: () => [],
    devCoreFilesSourceOf: () => "",
    execIconKeyOf: () => "",
    execColorOf: () => "",
    mediaGenOutputRaw: () => "",
    ttsSpeedOf: () => 1,
    ttsFormatOf: () => "wav",
    entryDisplayTitle: (e) => (e && e.title) || "",
    singleImageTitle: () => "",
    nodeHasImage: () => false,
    fnToolParamList: () => [],
    ensureFnToolNodeState: () => {},
    relArrowOf: () => "forward",
    clipStr: (s, n) => String(s == null ? "" : s).slice(0, n),
  };
  const code = [
    "(function () {",
    grabFunction(NODES, "clipStr"),
    grabFunction(NODES, "snapTextField"),
    grabFunction(NODES, "normalizeSnapshotOpts"),
    grabFunction(NODES, "nodeInFilter"),
    grabFunction(NODES, "pruneNodeSnap"),
    grabFunction(NODES, "pruneMinimalSnapshot"),
    /* 静态参考表按需闸（sections:["refs"]）：canvasSnapshot 出口会问它 */
    grabFunction(NODES, "snapshotWantsSection"),
    grabFunction(NODES, "snapshotWantsStaticRefs"),
    grabFunction(NODES, "attachSnapshotStaticRefs"),
    grabFunction(NODES, "resolveScopeHost"),
    grabFunction(NODES, "superAncestorIdsOf"),
    grabFunction(NODES, "superSubtreeIds"),
    grabFunction(NODES, "nodeInSuperScope"),
    grabFunction(NODES, "pointInScopeHost"),
    grabFunction(NODES, "scopedNodeIdSet"),
    grabFunction(NODES, "nodeInSnapshotScope"),
    grabFunction(NODES, "snapshotScopeOf"),
    grabFunction(NODES, "scopeInfoBlock"),
    /* 端子表推导：canvasSnapshot 在 standard / full 档对固定端子节点带 ports，走这一串 */
    grabFunction(NODES, "editPortNameOf"),
    grabFunction(NODES, "editPortKindOf"),
    grabFunction(NODES, "nodePortList"),
    grabFunction(NODES, "snapshotHasFixedPorts"),
    grabFunction(NODES, "snapshotInputGrowsWithWires"),
    grabFunction(NODES, "snapshotDynamicPortRule"),
    grabFunction(NODES, "snapshotPortsOf"),
    grabFunction(NODES, "canvasSnapshot"),
    "return { canvasSnapshot, snapshotScopeOf, scopeInfoBlock, scopedNodeIdSet, resolveScopeHost, superSubtreeIds, pointInScopeHost, snapshotWantsStaticRefs, attachSnapshotStaticRefs };",
    "})()",
  ].join("\n");
  const ctx = vm.createContext(sb);
  const api = vm.runInContext(code, ctx);
  return { sb, api };
}

const titles = (snap) => (snap.nodes || []).map((n) => n.id).sort();
const sameSet = (snap, list) =>
  (snap.nodes || []).length === list.length &&
  list.every((id) => snap.nodes.some((n) => n.id === id));

if (process.env.SCOPE_DEBUG) {
  const d = makeSandbox("");
  console.log("DEBUG byId dev", JSON.stringify(d.sb.nodeById("dev")));
  console.log("DEBUG byId title", JSON.stringify(d.sb.nodeById("开发壳")));
  console.log("DEBUG resolve", JSON.stringify(d.api.resolveScopeHost("开发壳")));
  console.log("DEBUG scopedIds", JSON.stringify([...d.api.scopedNodeIdSet(d.sb.S.wf.nodes[0], "direct")]));
  console.log(
    "DEBUG snap",
    JSON.stringify(d.api.canvasSnapshot({ scope: "开发壳" }).nodes.map((n) => n.id)),
  );
}

/* ══════════════════════ [1] 只读侧：scope 收窄 ══════════════════════ */
function part1() {
  section("1 canvasSnapshot({scope}) 只回某一颗壳内部");
  const { api } = makeSandbox("");
  const all = api.canvasSnapshot({ scope: "global" });
  ok(
    sameSet(all, ["dev", "f1", "g1", "sib", "top"]),
    "scope:\"global\" = 整张图（当前层能看到的节点一个不少）",
  );  const direct = api.canvasSnapshot({ scope: "开发壳" });
  ok(
    sameSet(direct, ["dev", "f1"]),
    "scope=\"开发壳\" 默认只回那颗壳 + 直接子节点：" + titles(direct).join(","),
  );
  const allDeep = api.canvasSnapshot({ scope: "开发壳", scopeDepth: "all" });
  ok(
    sameSet(allDeep, ["dev", "f1", "g1"]),
    "scopeDepth:\"all\" 回整棵子树（含孙节点）",
  );
  ok(
    (direct.wires || []).length === 0 && (allDeep.wires || []).length === 1,
    "连线跟着收窄：direct 无（f1→dev 那条线不在），all 保留壳内 1 条",
  );
  ok(
    (direct.marks || []).map((m) => m.id).join(",") === "m1",
    "绘制跟着收窄：壳外 m2 不再返回",
  );
  ok(
    (direct.groups || []).map((g) => g.title).join(",") === "壳内组",
    "分组跟着收窄：成员在界外的「跨壳组」不再返回",
  );
  ok(
    direct.nodes.filter((n) => n.id === "f1")[0].scopeNestedIn === undefined,
    "直接子块的宿主就在返回集里 → 不多塞 scopeNestedIn",
  );
  const narrowed = api.canvasSnapshot({ scope: "开发壳", scopeDepth: "all", ids: ["孙节点"] });
  ok(
    narrowed.nodes.length === 1 && narrowed.nodes[0].scopeNestedIn === "f1",
    "ids 再收窄时，宿主不在返回集里的节点补 scopeNestedIn=直接宿主 id",
  );
  ok(
    direct.scopeInfo &&
      direct.scopeInfo.mode === "subtree" &&
      direct.scopeInfo.hostTitle === "开发壳" &&
      direct.scopeInfo.depth === "direct",
    "scopeInfo 如实自报范围（mode / host / depth）",
  );
  ok(
    allDeep.scopeInfo && Array.isArray(allDeep.scopeInfo.above) === false,
    "顶层壳没有祖先 → scopeInfo 不带 above",
  );
  const nested = api.canvasSnapshot({ scope: "文件块", scopeDepth: "all" });
  ok(
    Array.isArray(nested.scopeInfo.above) && nested.scopeInfo.above[0].id === "dev",
    "钻进子块时 scopeInfo.above 给出祖先链（先看到自己在整图中的位置）",
  );
  const bad = api.canvasSnapshot({ scope: "不存在的壳" });
  ok(
    bad.nodes.length === 5,
    "scope 令牌解析不出来 → 退回当前口径（不静默给空图）",
  );
  const nonSuper = api.canvasSnapshot({ scope: "顶层节点" });
  ok(nonSuper.nodes.length === 5, "scope 给了非 super 节点 → 同样退回当前口径");
  const quoted = api.canvasSnapshot({ scope: '"开发壳"' });
  ok(
    sameSet(quoted, ["dev", "f1"]),
    "scope 写成带引号的样子仍能解析",
  );
  /* 端子预检：固定端子节点（super 边界等）在 standard / full 档直接带 ports，
     minimal 档必须不带（节点索引每轮重发，最轻）。 */
  ok(
    SNAPSHOT_PORT_KINDS.indexOf("super") >= 0,
    "端子数固定的节点名单含 super（与 app-nodes.js 真源同源，不另抄一份）",
  );
  ok(
    direct.nodes.every((n) => Array.isArray(n.ports) && n.ports.length > 0),
    "standard / full 档：固定端子节点带 ports（接线前看得见 index/name/kind/connectedTo）",
  );
  const port0 = direct.nodes.filter((n) => n.id === "dev")[0].ports[0];
  ok(
    port0 && port0.dir === "in" && port0.index === 0 && typeof port0.name === "string" &&
      typeof port0.kind === "string" && port0.kind.length > 0 && port0.connectedTo === null,
    "ports 条目含 dir/index/name/kind/connectedTo（未连线的端子 connectedTo=null）",
  );
  const minSnap = api.canvasSnapshot({ scope: "开发壳", detail: "minimal" });
  ok(
    minSnap.nodes.every((n) => n.ports === undefined),
    "minimal 档不带 ports（节点索引每轮重发，端子表只在要接线时按需拉）",
  );
}

/* ══════════════════════ [2] 默认整图 + 当前位置提示 ══════════════════════ */
function part2() {
  section("2 缺省不静默收窄，但点名用户当前停留的壳");
  const outside = makeSandbox("");
  const s1 = outside.api.canvasSnapshot({});
  ok(
    s1.nodes.length === 5 && s1.scopeInfo.mode === "global",
    "用户没停在壳里 → 默认整图（别的消费者不受影响）",
  );
  ok(!s1.scopeInfo.hint, "没有可提示的壳时不塞 hint");
  const inside = makeSandbox("dev");
  const s2 = inside.api.canvasSnapshot({});
  ok(
    s2.nodes.map((n) => n.id).join(",") === "dev,f1",
    "人停在壳里时「当前可见」本就是这一层 —— 快照跟着所见，不再整图灌入",
  );
  ok(
    s2.scopeInfo.origin === "screen" && s2.scopeInfo.hostTitle === "开发壳",
    "scopeInfo 说明这是「跟着屏幕所见」收窄的（origin=screen）",
  );
  const s3 = inside.api.canvasSnapshot({ scope: "global" });
  ok(
    s3.scopeInfo.mode === "global",
    "scope:\"global\" 仍能显式要整图（收窄只影响缺省口径）",
  );
  const s4 = inside.api.canvasSnapshot({ scope: "兄弟壳" });
  ok(
    s4.nodes.map((n) => n.id).join(",") === "sib,sibkid",
    "人在开发壳里也能用 scope=标题切去看兄弟壳内部（不必先退出去）",
  );
  const s5 = inside.api.canvasSnapshot({ scope: "不存在的壳" });
  ok(
    s5.nodes.map((n) => n.id).join(",") === "f1",
    "非法 scope 令牌退回当前口径，不炸也不给空图",
  );
}

/* ══════════════════════ [3] 写入侧：scope 闸 ══════════════════════ */
function part3() {
  section("3 applyCanvasEdit 的 scope 闸（界外不碰 + 默认落进 scope 壳）");
  const { sb, api } = makeSandbox("");
  const host = sb.S.wf.nodes.filter((n) => n.id === "dev")[0];
  const allowed = api.scopedNodeIdSet(host, "direct");
  const deep = api.scopedNodeIdSet(host, "all");
  ok(
    allowed.has("dev") && allowed.has("f1") && !allowed.has("g1") && !allowed.has("top"),
    "direct 允许集 = 壳 + 直接子节点（孙节点 / 界外节点不在内）",
  );
  ok(deep.has("g1") && !deep.has("sibkid"), "all 允许集多出孙节点，仍不含兄弟壳内部");
  ok(
    deep.has("dev") && api.scopedNodeIdSet(host, "all").has("f1"),
    "允许集始终含 scope 那颗壳自己（否则它自己的 devStatus 也改不了）",
  );
  const subtree = api.superSubtreeIds(host);
  ok(
    subtree.has("f1") && subtree.has("g1") && !subtree.has("dev"),
    "superSubtreeIds 只回子孙（不含自己，含孙）",
  );
  ok(
    api.pointInScopeHost(host, host.x + 10, host.y + 10) === true &&
      api.pointInScopeHost(host, host.x + 5000, host.y) === false,
    "pointInScopeHost：壳内坐标放行、远在界外的坐标拒绝",
  );
  has(NODES, "scopeExtra", "改动回执带上 scopeInfo（模型知道这次只改了一颗壳）");
  has(
    NODES,
    "scopeSkip(I18n.t(\"新节点 \") + alias)",
    "坐标落在界外的新节点被跳过（不会飘在根画布上）",
  );
  has(NODES, "if (outOfEditScope(node)) {", "update / remove 界外节点走同一条跳过闸");
  has(NODES, "outOfMarkScope", "绘制（mark）也有自己的界外判定");
  has(
    NODES,
    "node.parentSuperId = editScope.host.id;",
    "壳内 create 缺 parentSuperId 时默认落进 scope 那颗壳",
  );
  has(
    NODES,
    ").filter((n) => !editScope || editAllowed.has(n.id));",
    "自动排版的目标收窄到 scope 内（不顺手挪界外节点）",
  );
  has(
    NODES,
    "scope: params.scope, scopeDepth: params.scopeDepth",
    "画布操作回执里的快照用同一次调用的 scope",
  );
}

/* ══════════════════════ [4] 工具描述 / i18n / 装载 ══════════════════════ */
function part4() {
  section("4 工具描述 · i18n 中英成对 · 脚本装载");
  has(PLUGIN, "name: 'mtnode_canvas_get'", "canvas_get 仍在");
  has(PLUGIN, "Read ONLY the inside of this super / dev / db node", "canvas_get 说明写明 scope 口径");
  has(PLUGIN, "scopeInfo is always returned", "canvas_get 说明写明 scopeInfo 恒返回");
  has(
    read("mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md"),
    "局部画布（scope）：整笔调用只改某一颗超级 · 开发节点内部时传 scope=那颗壳",
    "canvas_edit 说明写明 scope 口径（完整规则真源在按需技能，工具描述只留卡口 + 一句指向）",
  );
  has(
    PLUGIN,
    "scope: { type: 'string', description: '局部画布：本次调用只在这一颗超级 · 开发节点内部",
    "scope 是 create / update 的属性表字段（与渲染层 applyCanvasEdit 同一入口）",
  );
  has(PLUGIN, "scopeDepth", "scopeDepth 参数在工具表里");
  has(NODES, "scopeInfoBlock", "渲染层产出 scopeInfo");
  has(NODES, "snapshotScopeOf", "渲染层算出本次范围（scope 显式优先）");
  for (const s of [
    "scope 界外已跳过：",
    "本次编辑被限定在这一颗壳内部：界外节点未改动。",
    "范围 = 这一颗壳内部：界外节点未返回。",
    "用户当前正停在这颗壳里：{title}（id {id}）。只看 / 只改它内部请传 scope 用这颗壳的标题或 id，配 scopeDepth 决定一层还是整棵 —— 避免整图灌进来浪费 token。",
  ]) {
    has(ZH, '"' + s + '":', "i18n 有英文词条：" + s.slice(0, 18) + "…");
  }
  I18n.setLocale && I18n.setLocale("en");
  const en = I18n.t("范围 = 这一颗壳内部：界外节点未返回。");
  ok(en.indexOf("Scope =") === 0, "英文界面下取到英文（不是回显中文 key）：" + en);
  ok(
    I18n.t("用户当前正停在这颗壳里：{title}（id {id}）。只看 / 只改它内部请传 scope 用这颗壳的标题或 id，配 scopeDepth 决定一层还是整棵 —— 避免整图灌进来浪费 token。", { title: "T", id: "i" }).indexOf("T (id i)") > 0,
    "hint 模板占位符能替换",
  );
  I18n.setLocale && I18n.setLocale("zh");
  const scripts = HTML.match(/<script src="([^"]+)"><\/script>/g) || [];
  ok(
    scripts.some((s) => s.indexOf("app-nodes.js") >= 0),
    "app-nodes.js 仍在 index.html 装载（scope 逻辑随它进渲染层）",
  );
  ok(
    NODES.indexOf("scopeInfoBlock(sc, allNodes)") >= 0,
    "scopeInfo 挂在快照末尾（重型块被 sections 过滤时也留得住）",
  );
  ok(
    NODES.indexOf("scopeInfo: scopeInfoBlock(sc, allNodes)") >= 0 &&
      /恒保留的只有极小信封：workflow \/ scopeInfo \/ assistScope · scopeNote/.test(NODES),
    "注释里写明 scopeInfo 恒保留（与 sections 白名单口径一致）",
  );
}

/* ══════════════════════ [5] minimal 档：纯节点索引 ══════════════════════ */
function part5() {
  section("5 minimal 档 = 纯节点索引（每节点只带标题 / 描述 / 类别）");
  ok(
    NODE_MINIMAL_KEYS.join(",") === "title,note,kind",
    "节点级白名单 = 标题 / 描述(note) / 类别(kind)（实测 " + NODE_MINIMAL_KEYS.join("/") + "）",
  );
  ok(
    MINIMAL_SNAPSHOT_SECTIONS.join(",") === "nodes",
    "minimal 档保留的重型块只有 nodes（实测 " + MINIMAL_SNAPSHOT_SECTIONS.join("/") + "）",
  );
  const { sb, api } = makeSandbox("");
  const devNode = sb.S.wf.nodes.filter((n) => n.id === "dev")[0];
  devNode.note = "开发壳说明";
  const min = api.canvasSnapshot({ detail: "minimal" });
  ok((min.nodes || []).length === 5, "minimal 仍回节点索引（每个可见节点一条）");
  const extra = [];
  for (const n of min.nodes || []) {
    for (const k of Object.keys(n)) if (NODE_MINIMAL_KEYS.indexOf(k) < 0) extra.push(k);
  }
  ok(
    extra.length === 0,
    "每个节点只带 " + NODE_MINIMAL_KEYS.join(" / ") + "，id / 坐标 / 尺寸 / 运行态 / 层级 / tags / 配置 / 正文一律不带" +
      (extra.length ? "（实测多出：" + extra.join(",") + "）" : ""),
  );
  ok(
    (min.nodes || []).every((n) => n.id === undefined && n.x === undefined && n.w === undefined && n.prompt === undefined),
    "节点上没有 id / x / w / prompt（正文键更是一个都没有）",
  );
  ok(
    min.nodes.filter((n) => n.title === "开发壳")[0].note === "开发壳说明",
    "描述(note)照常返回（它是 minimal 三要素之一）",
  );
  const heavy = ["marks", "wires", "groups", "taskTree", "superTree", "tagCatalog", "selection"].filter(
    (k) => k in min,
  );
  ok(heavy.length === 0, "重型块一个都不带（漏：" + heavy.join(",") + "）");
  const light = MINIMAL_SNAPSHOT_DROP.filter((k) => k in min);
  ok(light.length === 0, "视角与色卡（cam / view / 焦点 / markColors / devFuncColors）也不带（漏：" + light.join(",") + "）");
  /* 名单瘦身：三张静态参考表已从所有档位移除，改由 sections:["refs"] 按需补 —— 它们不在这份 DROP 里 */
  ok(
    ["kinds", "imageSizes", "defaultImageSize"].every((k) => MINIMAL_SNAPSHOT_DROP.indexOf(k) < 0),
    "MINIMAL_SNAPSHOT_DROP 不再列 kinds / imageSizes / defaultImageSize（改由 refs 闸按需补回）",
  );
  ok(!!min.workflow && min.workflow.name === "测试画布" && min.workflow.nodeCount === 6,
    "只留极小信封：workflow 身份（这是哪张图、多大）");
  ok(!!min.scopeInfo && min.scopeInfo.mode === "global",
    "scopeInfo 仍恒返回（模型知道这次读的是整图还是某颗壳内部）");
  const wiring = api.canvasSnapshot({ detail: "minimal", sections: ["nodes", "wires"] });
  ok(
    (wiring.wires || []).length > 0 && !("marks" in wiring),
    "sections 是白名单：minimal 档点名 [\"nodes\",\"wires\"] 仍能便宜地只查连线（marks 等仍不带）",
  );
  const full = api.canvasSnapshot({});
  ok(
    JSON.stringify(min).length * 2 < JSON.stringify(full).length,
    "同一张图 minimal vs full：" + JSON.stringify(min).length + " 字符 vs " + JSON.stringify(full).length +
      " 字符（缺省读图不再把整图配置灌进历史）",
  );
  /* 三张静态参考表（kinds / imageSizes / defaultImageSize）与画布内容无关：
     任何档位缺省都不带，只有 sections 点名 "refs" 才补回（见 app-nodes.js 的按需闸）。 */
  const REF_KEYS = ["kinds", "imageSizes", "defaultImageSize"];
  const refsOf = (snap) => REF_KEYS.filter((k) => k in snap);
  const std = api.canvasSnapshot({ detail: "standard" });
  ok(
    refsOf(min).length === 0 && refsOf(std).length === 0 && refsOf(full).length === 0,
    "三张静态参考表在 minimal / standard / full 三档缺省都不带（漏：" +
      [refsOf(min), refsOf(std), refsOf(full)].join("/") + "）",
  );
  ok(
    !!std.cam && Array.isArray(std.markColors) && !!std.devFuncColors,
    "detail:\"standard\" 仍带 cam / markColors / devFuncColors（口径不变）",
  );
  ok(
    typeof api.snapshotWantsStaticRefs === "function" &&
      api.snapshotWantsStaticRefs({ sections: ["refs"] }) === true &&
      api.snapshotWantsStaticRefs({ sections: ["staticRefs"] }) === true &&
      api.snapshotWantsStaticRefs({ sections: ["nodes"] }) === false &&
      api.snapshotWantsStaticRefs({}) === false,
    "refs 闸只认 sections 点名 \"refs\"（别名 \"staticRefs\"，容忍首尾空白；未点名 = 不带）",
  );
  const refsStd = api.canvasSnapshot({ detail: "standard", sections: ["refs"] });
  const refsMin = api.canvasSnapshot({ detail: "minimal", sections: ["refs"] });
  ok(
    Array.isArray(refsStd.kinds) && Array.isArray(refsStd.imageSizes) && !!refsStd.defaultImageSize &&
      refsStd.imageSizes.length > 0,
    "sections:[\"refs\"] 才把三张静态表带回来（kinds / imageSizes / defaultImageSize）",
  );
  ok(
    Array.isArray(refsMin.kinds) && Array.isArray(refsMin.imageSizes) && !!refsMin.defaultImageSize,
    "refs 补在裁剪之后：minimal 档显式点名也拿得到三张表（不被 MINIMAL_SNAPSHOT_DROP 再摘）",
  );
  const stdG1 = (std.nodes || []).filter((n) => n.title === "孙节点")[0];
  ok(
    stdG1 && stdG1.prompt === undefined && stdG1.promptLen === 2 && stdG1.id === "g1" && stdG1.x !== undefined,
    "standard 只有正文长度（prompt 不给、promptLen 给）+ 配置 / 坐标，仍是「配置档」不是「正文档」",
  );
  ok(
    (std.nodes || []).filter((n) => n.id === "dev")[0].ports.length > 0,
    "standard 档固定端子节点仍带 ports（接线前预检）",
  );
}

part1();
part2();
part3();
part4();
part5();
console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全绿") + "  (smoke-canvas-scope)",
);

/* ==================== 已并入：test/smoke-canvas-asset-get.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-canvas-asset-get.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

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
  const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);

  const APP = read("renderer/app.js");
  const NODES = read("renderer/app-nodes.js");
  const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");

  /* ── 源码抽函数（跑真实现，不读字面量）────────────────────────────────────── */
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
  const grabConst = (src, name) => {
    const re = new RegExp("^const\\s+" + name + "\\s*=[^;]*;", "m");
    const m = re.exec(src);
    if (!m) throw new Error("源码里找不到常量：" + name);
    return m[0];
  };

  /* 端子数固定的节点名单（快照在 standard / full 档给 ports）：从源码抽，测试不另抄 */
  const SNAPSHOT_PORT_KINDS = (() => {
    const m = NODES.match(/const SNAPSHOT_PORT_KINDS\s*=\s*\[[^\]]*\]/);
    return m ? (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
  })();

  /* ══════════ 迷你素材库：库摘要 + 条目视图缓存（真实取数只问这两个）═══════════ */
  const ROOT = "E:/assetlib";
  const SUM = {
    ast1: {
      id: "ast1",
      items: [
        { id: "i1", title: "角色设定", type: "text", absPath: ROOT + "/ast1/角色设定.txt", bytes: 30, missing: false },
        { id: "i2", title: "立绘", type: "image", absPath: ROOT + "/ast1/立绘.png", bytes: 1024, missing: false },
        { id: "i3", title: "主题曲", type: "audio", absPath: ROOT + "/ast1/主题曲.mp3", bytes: 2048, missing: false },
        { id: "i4", title: "丢失的稿子", type: "text", absPath: ROOT + "/ast1/没了.txt", bytes: 0, missing: true },
      ],
    },
  };
  const VIEWS = {
    "ast1/i1": { savedText: "主角：沉默的修表匠", missing: false, absPath: ROOT + "/ast1/角色设定.txt" },
  };
  const LOADS = [];

  /* 画布上的一颗素材节点：绑定 ast1，四条内容 = 四个端子，其中 i1 已被策略节点接住 */
  const ASSET_NODE = {
    id: "a1",
    kind: "asset",
    title: "角色素材",
    x: 0,
    y: 0,
    w: 300,
    h: 320,
    assetId: "ast1",
    assetRel: "角色/主角组",
    assetName: "主角组素材",
    assetDesc: "角色设定与立绘",
    items: [
      { id: "i1", title: "角色设定", type: "text" },
      { id: "i2", title: "立绘", type: "image" },
      { id: "i3", title: "主题曲", type: "audio" },
      { id: "i4", title: "丢失的稿子", type: "text" },
    ],
  };
  const DOWN_NODE = { id: "p1", kind: "proc_text", title: "写分镜", x: 400, y: 0, w: 240, h: 160, prompt: "用 @角色设定" };
  const SRC_NODE = { id: "s1", kind: "input_text", title: "补充设定", x: -400, y: 0, w: 240, h: 160, text: "旧稿" };
  /* 两条真连线：0 号出端子喂给下游（占用看得见）；0 号入端子被上游写住（素材节点也收内容） */
  const WIRES = [
    { id: "w1", from: "a1", to: "p1", fromIndex: 0, toIndex: 0 },
    { id: "w2", from: "s1", to: "a1", fromIndex: 0, toIndex: 0 },
  ];

  const WFDEP = {
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
    Promise,
    Date,
    I18n: {
      t: (k, vars) => {
        let s = I18n.t(k);
        if (vars && typeof vars === "object")
          s = s.replace(/\{(\w+)\}/g, (_, kk) => (vars[kk] == null ? "" : String(vars[kk])));
        return s;
      },
    },
    S: { wf: { id: "wf1", name: "素材画布", nodes: [ASSET_NODE, DOWN_NODE, SRC_NODE], wires: WIRES, marks: [], groups: [] }, view: "workflow", cam: { x: 0, y: 0, z: 1 } },
    IMAGE_SIZES: ["auto"],
    DEFAULT_IMAGE_SIZE: "auto",
    NODE_DEFAULTS: { asset: { title: "素材", w: 300, h: 260 } },
    MARK_COLORS: ["#ffffff"],
    SNAPSHOT_PORT_KINDS,
    /* 素材库边界（真 assetItemSummary / assetItemAbsPath 只问这四个） */
    assetSummaryById: (id) => SUM[String(id)] || null,
    assetItemViewGet: (id, itemId) => VIEWS[String(id) + "/" + String(itemId)] || null,
    assetItemViewLoad: (id, itemId) => {
      LOADS.push(String(id) + "/" + String(itemId));
    },
    assetItemViewLoaded: (id, itemId) => {
      const k = String(id) + "/" + String(itemId);
      LOADS.push(k);
      if (k === "ast1/i1")
        VIEWS[k] = { text: "主角：沉默的修表匠", savedText: "主角：沉默的修表匠", missing: false, absPath: ROOT + "/ast1/角色设定.txt" };
      return Promise.resolve();
    },
    assetNodeIsLost: () => false,
    nodeById: (id) => ((WFDEP.S.wf && WFDEP.S.wf.nodes) || []).find((n) => n.id === id || n.title === id) || null,
    inputCount: (n) => ((n && n.items) || []).length,
    outputCount: (n) => ((n && n.items) || []).length,
    isSuperIoNode: () => false,
    isFnToolNode: () => false,
    isControlKind: () => false,
    /* portRule 的判据（snapshotInputGrowsWithWires）：增量名单 + 「端子数 = 已连数据线 + 1」。
       素材节点不在名单里（条目即端子），两条桩照实体给即可。 */
    INCREMENTAL_PORT_KINDS: ["proc_text", "proc_image", "sensenova_gen", "agent_task", "input_text", "input_image", "input_file", "input_any"],
    allWiresTo: (id) => (WIRES || []).filter((w) => w.to === id),
    isToolNode: () => false,
    isFunctionNode: () => false,
    fnToolPortKind: () => "any",
    fnToolParamList: () => [],
    isNetNode: () => false,
    isCustomVideoGen: () => false,
    isVideoPostKind: () => false,
    normalizeNodeTags: () => [],
    canUseGlobalRefs: () => false,
    wfTagCatalog: () => [],
    devFuncColorCatalog: () => [],
    currentTaskFocus: () => "",
    currentSuperFocus: () => "",
    nodeInCurrentScope: (n) => !(n && n.parentSuperId),
    markInCurrentScope: () => true,
    nodeParentTaskId: () => "",
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    devKindOf: () => "module",
    devColorOf: () => "",
    devCoreFilesOf: () => [],
    devCoreFilesSourceOf: () => "",
    execIconKeyOf: () => "",
    execColorOf: () => "",
    mediaGenOutputRaw: () => "",
    ttsSpeedOf: () => 1,
    ttsFormatOf: () => "wav",
    entryDisplayTitle: (e) => (e && e.title) || "",
    singleImageTitle: () => "",
    nodeHasImage: () => false,
    ensureFnToolNodeState: () => {},
    relArrowOf: () => "forward",
  };

  function makeApi() {
    const ctx = vm.createContext(WFDEP);
    const code = [
      "(function () {",
      grabConst(APP, "ASSET_ITEM_TYPES"),
      grabConst(NODES, "NODE_BODY_KEYS"),
      grabFunction(APP, "mediaFileUrlOf"),
      grabFunction(APP, "isAssetNode"),
      grabFunction(APP, "assetItems"),
      grabFunction(APP, "assetPortKind"),
      grabFunction(APP, "assetItemSummary"),
      grabFunction(APP, "assetItemAbsPath"),
      grabFunction(NODES, "clipStr"),
      grabFunction(NODES, "snapTextField"),
      grabFunction(NODES, "normalizeSnapshotOpts"),
      grabFunction(NODES, "nodeInFilter"),
      grabFunction(NODES, "pruneNodeSnap"),
      grabFunction(NODES, "editPortNameOf"),
      grabFunction(NODES, "editPortKindOf"),
      grabFunction(NODES, "nodePortList"),
      grabFunction(NODES, "snapshotHasFixedPorts"),
      grabFunction(NODES, "snapshotInputGrowsWithWires"),
      grabFunction(NODES, "snapshotDynamicPortRule"),
      grabFunction(NODES, "snapshotPortsOf"),
      grabFunction(NODES, "snapshotAssetNodeOf"),
      grabFunction(NODES, "assetItemAgentValue"),
      grabFunction(NODES, "snapshotAssetItemsLoad"),
      grabFunction(NODES, "snapshotAssetContentOf"),
      "return { snapshotAssetNodeOf, snapshotPortsOf, snapshotHasFixedPorts, snapshotAssetContentOf, assetItems, assetPortKind, nodePortList, pruneNodeSnap, normalizeSnapshotOpts };",
      "})()",
    ].join("\n");
    /* canvasSnapshot 本体太大（依赖几十个兄弟函数），本测试只测它里面素材节点那一段：
       用真的序列化片段 + 真的端子推导拼出「快照里的节点」，再走真的
       pruneNodeSnap / snapshotPortsOf / snapshotAssetContentOf / nodePortList。 */
    return vm.runInContext(code, ctx);
  }

  /* 按 canvasSnapshot 的真实口径构造「本次返回的节点」：
     assetItems 字段 + standard / full 的 ports + pruneNodeSnap 裁剪 */
  function snapshotNodeOf(api, node, detail) {
    const o = { detail: detail || "standard", wantBodies: detail === "full", bodyLimit: 0 };
    const out = {
      id: node.id,
      kind: node.kind,
      title: node.title,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      assetItems: api.snapshotAssetNodeOf(node),
    };
    if (detail !== "minimal" && api.snapshotHasFixedPorts(node)) {
      const ports = api.snapshotPortsOf(node);
      if (ports && ports.length) out.ports = ports;
    }
    return api.pruneNodeSnap(out, o);
  }

  /* ══════════════════════ [1] 条目清单 + 端子表 ══════════════════════ */
  async function part1() {
    section("1 素材节点进快照：绑定 + 条目清单 + 端子表（minimal 档不带）");
    const api = makeApi();
    const std = snapshotNodeOf(api, ASSET_NODE, "standard");

    ok(
      std.assetItems && std.assetItems.assetId === "ast1",
      "standard 档回读 assetItems.assetId（Agent 知道它绑的是库里哪份素材）",
    );
    ok(
      std.assetItems.assetName === "主角组素材" &&
        std.assetItems.assetRel === "角色/主角组" &&
        std.assetItems.assetDesc === "角色设定与立绘",
      "assetItems 带回显示名 / 相对路径 / 描述（与素材设置框同一份字段）",
    );
    ok(std.assetItems.itemCount === 4, "itemCount = 内容条目数（= 端子数）");
    ok(
      std.assetItems.items.length === 4 &&
        std.assetItems.items[0].index === 0 &&
        std.assetItems.items[0].id === "i1" &&
        std.assetItems.items[0].title === "角色设定" &&
        std.assetItems.items[0].type === "text",
      "条目清单逐条给 index / id / title / type（端子号 = 条目号）",
    );
    ok(
      !("text" in std.assetItems.items[0]),
      "standard 档只给清单，不给条目正文（与 text / prompt 的正文档位纪律一致）",
    );

    const ins = std.ports.filter((p) => p.dir === "in");
    const outs = std.ports.filter((p) => p.dir === "out");
    ok(ins.length === 4 && outs.length === 4, "ports 入出各 4 个：第 i 入 ↔ 第 i 出（条目即端子）");
    ok(
      ins[0].name === "角色设定" && ins[1].name === "立绘" && outs[2].name === "主题曲",
      "端子名 = 内容条目标题（与画布端子徽标同一口径，不再显示「输入端子 N」）",
    );
    ok(
      ins[0].kind === "text" && ins[1].kind === "image" && ins[2].kind === "audio",
      "端子类型 = 条目类型（text / image / audio）",
    );
    ok(
      ins[0].connectedTo && ins[0].connectedTo[0].node === "补充设定",
      "ports 入侧 connectedTo 指出 0 号端子被上游「补充设定」写住",
    );
    ok(
      outs[0].connectedTo && outs[0].connectedTo[0].node === "写分镜" && outs[0].connectedTo[0].port === 0,
      "ports 出侧 connectedTo 指出 0 号端子喂给了「写分镜」（接线前就看得见，不必等 connect 报错）",
    );
    ok(ins[1].connectedTo === null && outs[1].connectedTo === null, "空着的端子 connectedTo 为 null");

    const min = snapshotNodeOf(api, ASSET_NODE, "minimal");
    ok(
      !min.assetItems && !min.ports && Object.keys(min).join(",") === "title,kind",
      "minimal 档只有 title / kind（app_state 每轮重发，素材清单不进最小档）：" + JSON.stringify(min),
    );
  }

  /* ══════════════════════ [2] full 档条目正文 ══════════════════════ */
  async function part2() {
    section("2 full / bodies 档：条目正文与媒体路径（读不到如实报 missing）");
    const api = makeApi();
    const snap = { nodes: [snapshotNodeOf(api, ASSET_NODE, "full")] };
    LOADS.length = 0;
    await api.snapshotAssetContentOf(snap, { detail: "full" });
    const items = snap.nodes[0].assetItems.items;

    ok(
      items[0].text === "主角：沉默的修表匠" && items[0].textLen === 9,
      "文本条目给正文 + textLen（agent 不必再去应用数据目录翻文件）",
    );
    ok(
      items[1].path === ROOT + "/ast1/立绘.png" &&
        /^file:\/\/\/E:\/assetlib\/ast1\//.test(items[1].url),
      "图像条目给本机路径 + file:/// URL（可用 mtnode_vision 读、也可交给下游）",
    );
    ok(items[3].missing === true, "库里内容文件缺失的条目如实报 missing（不抛、不静默当空）");
    ok(
      LOADS.indexOf("ast1/i2") < 0,
      "媒体条目不触发正文读取（值本来就来自库摘要，省一次 IPC）",
    );

    /* standard / bodies:false 一律不补正文 */
    const stdSnap = { nodes: [snapshotNodeOf(api, ASSET_NODE, "standard")] };
    await api.snapshotAssetContentOf(stdSnap, { detail: "standard" });
    ok(
      !("text" in stdSnap.nodes[0].assetItems.items[0]),
      "standard 档不补正文（要全文显式 detail:\"full\" / bodies:true）",
    );
    const noBodies = { nodes: [snapshotNodeOf(api, ASSET_NODE, "full")] };
    await api.snapshotAssetContentOf(noBodies, { detail: "full", bodies: false });
    ok(
      !("text" in noBodies.nodes[0].assetItems.items[0]),
      "bodies:false 时不补正文（与其它正文同一条闸）",
    );

    /* bodyLimit：截断照其它正文口径，长度提示符恒为真长度 */
    const lim = { nodes: [snapshotNodeOf(api, ASSET_NODE, "full")] };
    await api.snapshotAssetContentOf(lim, { detail: "full", bodyLimit: 4 });
    ok(
      lim.nodes[0].assetItems.items[0].text === "主角：沉" &&
        lim.nodes[0].assetItems.items[0].textLen === 9,
      "bodyLimit 截断条目正文，textLen 恒为真长度（与 text / prompt 同一口径）",
    );

    /* 非素材节点 / 未绑定节点：本段整体 no-op */
    const plain = { nodes: [{ id: "p1", kind: "proc_text", title: "写分镜" }] };
    await api.snapshotAssetContentOf(plain, { detail: "full" });
    ok(plain.nodes[0].text === undefined, "非素材节点不受这一段影响");

    const unbound = { nodes: [snapshotNodeOf(api, { id: "a2", kind: "asset", title: "空素材", items: [] }, "standard")] };
    ok(
      unbound.nodes[0].assetItems && unbound.nodes[0].assetItems.itemCount === 0,
      "还没绑定 / 没有条目的素材节点也给 assetItems（itemCount:0，不是整个字段消失）",
    );
    ok(
      api.snapshotHasFixedPorts({ id: "a2", kind: "asset", items: [] }) === true &&
        (api.snapshotPortsOf({ id: "a2", kind: "asset", items: [] }) || []).length === 0 &&
        snapshotNodeOf(api, { id: "a2", kind: "asset", title: "空素材", items: [] }, "standard").ports === undefined,
      "没有条目的素材节点不给空 ports（回执里的 ports 判据会滤掉空表，不给模型一份误导的端子表）",
    );
  }

  /* ══════════════════════ [3] 源码口径静态核对 ══════════════════════ */
  function part3() {
    section("3 源码口径（hash / 描述 / 不写回节点）");
    has(
      NODES,
      "assetItems: snapshotAssetNodeOf(n),",
      "canvasSnapshot 的节点序列化里带上 assetItems（本轮 bug 的根因处）",
    );
    has(
      NODES,
      "if (isAssetNode(node)) return true;",
      "snapshotHasFixedPorts 认素材节点（端子 = 条目，进 ports 预检）",
    );
    has(
      NODES,
      "if (isAssetNode(node)) return assetPortKind(node, dir, i) || \"control\";",
      "editPortKindOf 走 assetPortKind 真源（端子类型 = 条目类型）",
    );
    has(
      NODES,
      "await snapshotAssetContentOf(snap, opts || {});",
      "canvasSnapshotFull 在算 contentHash 之前补读素材条目正文（同参重读才判得准）",
    );
    ok(
      NODES.indexOf("await snapshotAssetContentOf(snap, opts || {});") <
        NODES.indexOf("snap.contentHash = snapshotContentHashOf(snap);"),
      "补读发生在 contentHash 之前（否则库内容变了仍被判「无变化」）",
    );
    /* 只读投影：绝不把库正文写回节点数据（画布存档不能因此膨胀） */
    const body = grabFunction(NODES, "snapshotAssetContentOf");
    ok(
      !/node\.items\s*=|node\.assetId\s*=/.test(body),
      "snapshotAssetContentOf 只改快照副本，不写回节点数据",
    );
    ok(!/writeFile|assetsItemWrite/.test(body), "快照路径不打任何写盘口（纯读）");

    has(
      PLUGIN,
      "assetItems = 绑定与条目清单 items:[{index, id, title, type}]",
      "canvas_get 描述写明素材节点的回读形状（模型知道去哪读，不必翻文件系统）",
    );
    has(
      PLUGIN,
      "/ super / asset) carry ports:",
      "canvas_get 描述把素材节点并进 ports 预检名单",
    );
    has(
      PLUGIN,
      "素材条目正文",
      "full 档说明写明素材条目正文也在这一档",
    );
  }

  (async () => {
    part1();
    await part2();
    part3();
    console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "全部通过 " + checks + "/" + checks + " 项"));
  })();
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-canvas-asset-get.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-canvas-asset-get.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-canvas-shot-tool.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-canvas-shot-tool.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");

  const ROOT = path.join(__dirname, "..");
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
  const PLUGIN = read("dsh", "gateway", "canvas-plugin.mjs");
  const NODES = read("renderer", "app-nodes.js");
  const APP = read("renderer", "app.js");
  const ASSIST = read("renderer", "app-assist.js");
  const I18N = read("renderer", "i18n.js");

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok  " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };
  const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
  const count = (src, needle) => src.split(needle).length - 1;

  /* 取顶格函数体（到下一个顶格 "}" 为止） */
  const fnOf = (src, name) => {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) return "";
    const end = src.indexOf("\n}", at);
    return end > at ? src.slice(at, end + 2) : "";
  };

  console.log("\n[1] 工具面：mtnode_app 的 export_canvas_png（不加新工具）");
  {
    has(PLUGIN, "'export_canvas_png',", "mtnode_app 的 action enum 收了 export_canvas_png");
    const appDesc = PLUGIN.slice(
      PLUGIN.indexOf("const APP_DESC"),
      PLUGIN.indexOf("/* 工具描述只留「卡口」"),
    );
    has(appDesc, "export_canvas_png: take a high-resolution PNG", "APP_DESC 有这只动作的条目");
    has(appDesc, "footer camera button", "APP_DESC 说清它就是页脚相机按钮那条链路");
    has(appDesc, "mtnode_vision", "APP_DESC 指路：要真的看懂图就交给 mtnode_vision");
    has(appDesc, "in the background", "APP_DESC 说清前台口径（不在前台会被拒）");
    has(PLUGIN, "For export_canvas_png: absolute .png output path", "path 参数写明是绝对 .png 路径");
    const toolCount = count(PLUGIN, "    name: 'mtnode_");
    ok(toolCount === 4, "canvas-plugin 仍只注册 4 只工具（实测 " + toolCount + "），没为拍照多开一只");
    const visibility = read("dsh", "gateway", "tool-visibility.mjs");
    ok(visibility.indexOf("export_canvas_png") < 0, "可裁名单无需追加（没有新工具名）");
  }

  console.log("\n[2] 宿主分发：许可两道闸 + 前台口径 + 落盘两条路");
  {
    const gate = NODES.slice(
      NODES.indexOf('} else if (action === "export_canvas_png") {'),
      NODES.indexOf('} else if (action === "export_canvas_png") {') + 400,
    );
    has(gate, 'ensureAgentTool("app_ops"', "走「应用操作」许可（app_ops）");
    has(gate, 'ensureAgentTool("canvas_read"', "走「读画布」许可（canvas_read）");
    has(
      NODES,
      "return await captureCanvasForAgent(params, boundWf);",
      "action 分派到 captureCanvasForAgent",
    );
    has(
      NODES,
      "画布拍照是截屏：只能拍屏幕上正显示的那张画布。",
      "前台口径：所属画布不在前台时明确拒绝（截屏拍不到后台画布）",
    );
    const fgAt = NODES.indexOf("if (action === \"export_canvas_png\") {");
    const fgGuard = NODES.indexOf("String(boundWf.id) !== String(fg.id)", fgAt);
    ok(fgAt >= 0 && fgGuard > fgAt, "前台判定与 select_nodes / undo / redo 同一口径（currentVisibleWf）");

    const fn = fnOf(NODES, "captureCanvasForAgent");
    ok(fn.length > 0, "找得到 captureCanvasForAgent");
    has(fn, "exportCanvasOverviewPng({ fromAgent: true })", "复用页脚相机那条链路（同一套瓦片拼接 / 相机复位）");
    has(fn, "const restore = revealCanvasForShot();", "会话 / 团队视图下先把画布显示出来再拍");
    has(fn, "restore();", "拍完原样收回视图");
    ok(
      /finally\s*\{[\s\S]{0,300}?restore\(\);/.test(fn),
      "finally 里兜底收回视图（拍失败也不会把界面停在画布上）",
    );
    has(fn, "assetWriteBase64(", "默认落本画布资产目录（%APPDATA% 侧，不落应用文件夹）");
    has(fn, 'storedIn = "asset"', "回执说明落到了资产目录");
    has(fn, "fileWriteBytes(dest, base64ToBytes(shot.base64))", "给了 path 就写那个绝对路径（字节写入）");
    has(fn, "isAbsPath(outPath)", "path 必须是本机绝对路径");
    has(fn, "/\\.png$/i.test(outPath)", "只接受 .png 后缀");
    has(fn, "path: dest", "回执交出落盘路径（交给识图 / 用户）");
    has(fn, "mtnode_vision", "回执指路识图");
    ok(
      /if \(\/empty\/i\.test\(msg\)\)/.test(fn),
      "窗口最小化 / 不可见导致 capturePage 回 empty 时，给一句用户能照做的提示",
    );

    const denied = NODES.slice(
      NODES.indexOf("const PLAN_DENIED_APP_ACTIONS"),
      NODES.indexOf("function canvasOpMutates("),
    );
    ok(denied.indexOf("export_canvas_png") < 0, "规划模式下不拦（只读动作，不改画布内容）");
  }

  console.log("\n[3] 拍照链路：按钮路径一字未变、工具路径不弹保存框");
  {
    const fn = fnOf(APP, "exportCanvasOverviewPng");
    ok(fn.length > 0, "找得到 exportCanvasOverviewPng");
    has(fn, "const fromAgent = !!o.fromAgent;", "用 opts.fromAgent 区分两条路径");
    ok(
      /if \(!fromAgent && S\.view === "agent"\)/.test(fn),
      "「请先切换到画布」的提示只留给按钮路径（工具路径自己会临时显示画布）",
    );
    ok(
      /if \(fromAgent\) throw new Error\(I18n\.t\("当前没有打开的画布"\)\)/.test(fn),
      "工具路径没有画布 / 没有内容时抛错（变成模型能读的失败回执），不弹 toast",
    );
    ok(
      /if \(S\._capturingCanvas\)[\s\S]{0,200}?fromAgent\) throw new Error/.test(fn),
      "重入保护：已在拍时工具路径明确失败（截图期间相机被瓦片循环反复指定）",
    );
    const retAt = fn.indexOf("if (fromAgent) {");
    const saveAt = fn.indexOf("const dest = await window.api.fileSaveDialog(");
    ok(retAt >= 0 && saveAt > retAt, "工具路径在保存框之前就返回（不弹保存框、不打开所在目录）");
    has(fn, "if (fromAgent) throw e;", "工具路径的失败原样抛出，不乱弹 toast");
    has(fn, "base64: bytesToBase64(new Uint8Array(shotBuf))", "以 base64 交回调用方落盘");
    /* 按钮路径的确认框仍在 */
    has(fn, "const ok = await confirmDialog(", "按钮路径仍先弹确认框");
    ok(
      /if \(!fromAgent\) \{\s*const ok = await confirmDialog\(/.test(fn),
      "确认框只在按钮路径（工具调用本身就是用户意图，不用模态框卡住一轮运行）",
    );

    const reveal = fnOf(APP, "revealCanvasForShot");
    ok(reveal.length > 0, "找得到 revealCanvasForShot");
    has(reveal, '$("#wfWrap")', "临时显示 #wfWrap");
    has(reveal, '$("#agentPane"), $("#teamPane")', "同时收掉会话 / 团队面板");
    has(reveal, "wrap.style.display = saved.wrap", "收回原样（按拍之前的 display 还原）");
    ok(reveal.indexOf("S.view =") < 0, "不动 S.view（只是临时显示，不切视图）");
  }

  console.log("\n[4] safeApp / 系统提示词 / i18n");
  {
    has(ASSIST, "undo|redo|export_canvas_png", "app_state 的 safe 清单列出该动作（不触发确认框）");
    ok(
      count(ASSIST, "export_canvas_png") >= 3,
      "safeApp + 限定范围 / 全局两段系统提示词都列了它（实测 " +
        count(ASSIST, "export_canvas_png") +
        " 处）",
    );
    const keys = [
      "正在生成总览图，请稍后重试。",
      "当前环境不支持画布拍照",
      "生成总览图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。",
      "画布拍照是截屏：只能拍屏幕上正显示的那张画布。本会话所属画布当前不在前台，请先切换到它再拍。",
      "path 必须是本机绝对路径：",
      "画布总览图只能保存为 .png：",
      "已拍下整张画布（节点 + 连线 + 标注）。要真的看懂图里内容，把 path 交给 mtnode_vision 识图；拍图期间画面会短暂移动，已自动恢复。",
    ];
    for (const k of keys) ok(I18N.indexOf('"' + k + '"') >= 0, "i18n 有词条：「" + k.slice(0, 16) + "…」");
    /* 词条后面必须跟着英文译文（下一行不是中文键再起一行） */
    for (const k of keys) {
      const at = I18N.indexOf('"' + k + '"');
      const seg = I18N.slice(at, at + k.length + 400);
      ok(/:\s*\n?\s*"/.test(seg.slice(k.length + 2)), "词条有英文译文：「" + k.slice(0, 16) + "…」");
    }
    ok(I18N.indexOf('"生成总览图失败："') >= 0, "复用既有「生成总览图失败：」词条（工具路径也报同一句）");
  }

  console.log("\n[5] base64 互转：真跑一遍字节往返");
  {
    const src = fnOf(APP, "bytesToBase64") + "\n" + fnOf(APP, "base64ToBytes");
    ok(src.length > 0, "找得到两个转换函数");
    /* eslint-disable no-new-func */
    const fns = new Function(src + "\nreturn { bytesToBase64, base64ToBytes };")();
    const bytes = new Uint8Array(70000); /* 跨过 0x8000 分块边界，复现曾经的爆栈场景 */
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
    const b64 = fns.bytesToBase64(bytes);
    ok(b64.length === Math.ceil(bytes.length / 3) * 4, "base64 长度符合 4 的倍数口径（" + b64.length + "）");
    const back = fns.base64ToBytes(b64);
    let same = back.length === bytes.length;
    for (let i = 0; same && i < bytes.length; i++) if (back[i] !== bytes[i]) same = false;
    ok(same, "70,000 字节往返无损（分块不爆栈、字节不错位）");
    ok(fns.base64ToBytes("").length === 0, "空串安全");
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-canvas-shot-tool)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-canvas-shot-tool)\n",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-canvas-shot-tool.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-canvas-shot-tool.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-canvas-intent.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-canvas-intent.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  const ASSIST = fs.readFileSync(path.join(ROOT, "renderer", "app-assist.js"), "utf8");
  const HTML = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");

  let fails = 0;
  const ok = (cond, msg) => {
    console.log((cond ? "  ok    " : "FAIL  ") + msg);
    if (!cond) fails++;
  };
  const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + JSON.stringify(got) + "）");

  /* 按锚点把真函数抠出来（不引整份 app-assist.js：它顶层就要 DOM / 全局） */
  function grabFunction(src, name) {
    const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
    const m = re.exec(src);
    if (!m) {
      ok(false, "app-assist.js 里应定义函数 " + name);
      return "";
    }
    const open = src.indexOf("{", src.indexOf(")", m.index));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(m.index, i + 1);
      }
    }
    ok(false, name + " 的括号没配平");
    return "";
  }

  const sb = { console, String, Array, RegExp };
  vm.createContext(sb);
  vm.runInContext(
    grabFunction(ASSIST, "agentCanvasTurnRelated") +
      "\n" +
      grabFunction(ASSIST, "assistCanvasTurnRelated") +
      "\nglobalThis.__rel = agentCanvasTurnRelated;\nglobalThis.__relA = assistCanvasTurnRelated;",
    sb,
    { filename: "app-assist.js#canvas-intent" },
  );
  const related = sb.__rel;
  const relatedA = sb.__relA;
  ok(typeof related === "function", "抠到 agentCanvasTurnRelated 真函数");
  ok(typeof relatedA === "function", "抠到助手侧包装 assistCanvasTurnRelated");

  console.log("\n[1] 明确指向画布 / 节点图的措辞 → 有关（照常读画布）");
  for (const s of [
    "帮我把这三张图连成批处理",
    "总结一下这张画布",
    "这个工作流跑不通，看看哪一步",
    "给『文本节点 2』换个模型",
    "把输出端子拖到空白处建一个保存节点",
    "整理一下排版，控制节点放上面",
    "接一个数据库副本进来",
    "@内容条目 引用一下",
    "check the nodes on this canvas",
    "wire the prompt to the image node",
  ]) {
    eq(related(s), true, "有关：" + s.slice(0, 18));
  }

  console.log("\n[2] 明确声明无关 → 无关（这一条才真的省下画布工具与快照）");
  for (const s of [
    "这个任务与画布无关，帮我改一下 README",
    "跟画布无关，只看这个文件",
    "不用管画布，读一下 E:\\dev\\a.md",
    "canvas-free task: rewrite these docs",
  ]) {
    eq(related(s), false, "无关：" + s.slice(0, 18));
  }

  console.log("\n[3] 判不准一律按「有关」处理（默认档，绝不误抽画布工具）");
  for (const s of [
    "",
    "你好",
    "帮我写一篇 800 字的说明文",
    "读一下 E:\\dev\\tools\\pipeline-console\\README.md",
    "跑一下 npm test 看看",
    "translate this paragraph into Japanese",
  ]) {
    eq(related(s), true, "按有关（兜底）：" + (s ? s.slice(0, 18) : "（空消息）"));
  }

  console.log("\n[4] 接续轮：这一轮没复述关键词，但最近几轮在讲画布 → 仍有关");
  eq(related("继续", ["帮我把这三张图连成批处理"]), true, "「继续」+ 上一轮在讲画布 → 有关（上下文还在图上）");
  eq(related("改一下颜色", ["给保存节点换个目录"]), true, "「改一下颜色」+ 上一轮讲节点 → 有关");
  eq(related("继续", ["读一下 README", "跑一下测试"]), true, "最近几轮与画布无关也仍按「有关」兜底（不误抽）");
  eq(related("继续", []), true, "没有历史 → 兜底按有关");
  eq(related("与画布无关", ["帮我把这三张图连成批处理"]), false, "本轮明说无关 → 照本轮说的办（不看历史）");
  eq(relatedA("帮我把这三张图连成批处理"), true, "助手侧包装同一判据（有关）");
  eq(relatedA("这个任务与画布无关"), false, "助手侧包装同一判据（无关）");

  console.log("\n[5] 接线：两处判据只由这一个函数产生；手动的按钮已移除");
  ok(ASSIST.indexOf("const turnCanvasFree =") >= 0 && /!!st\.canvasFree \|\|/.test(ASSIST),
    "会话侧 turnCanvasFree = 显式声明 ∪ 自动判定（显式位留给插件修复等特殊入口）");
  ok(ASSIST.indexOf("!agentCanvasTurnRelated(t, agentSessionUserHistory(st, null))") >= 0,
    "会话侧自动判定读「这轮消息 + 最近几轮用户消息」");
  ok(ASSIST.indexOf("noCanvas: turnCanvasFree,") >= 0, "会话侧下发 noCanvas = turnCanvasFree（人设与整档闸同源）");
  ok(ASSIST.indexOf("const assistCanvasFree = !assistCanvasTurnRelated(t)") >= 0,
    "助手侧改成按这条消息自动判定（不再读 S.assistCanvasFree）");
  ok(ASSIST.indexOf("noCanvas: assistCanvasFree,") >= 0, "助手侧下发 noCanvas = assistCanvasFree");
  ok(ASSIST.indexOf("S.assistCanvasFree\n") < 0, "运行路径里不再有读 S.assistCanvasFree 的判据");
  const assistRuns = ASSIST.split("\n").filter(
    (l) =>
      /S\.assistCanvasFree/.test(l) &&
      !/S\.config\.assistCanvasFree\s*=/.test(l) &&
      l.trim().slice(0, 2) !== "//" &&
      l.trim().slice(0, 1) !== "*" &&
      /;\s*$/.test(l.trim()),
  );
  ok(assistRuns.length === 0,
    "没有任何读 S.assistCanvasFree 的活代码（落盘兼容位那一行是赋值不是判据，得到 " + assistRuns.length + " 处）");
  ok(HTML.indexOf("agentCanvasFreeTrigger") < 0, "会话输入区的「与画布无关」chip 已从 index.html 移除");
  ok(HTML.indexOf("assistCanvasFreeBtn") < 0, "助手栏的「与画布无关」按钮已从 index.html 移除");
  ok(HTML.indexOf("assist-canvasfree-btn") < 0, "按钮的样式钩子也不再出现在页面里");
  ok(/agentCanvasTurnRelated/.test(HTML), "index.html 的注释指向自动判定函数（后来人知道判据在哪）");
  const BOOT = fs.readFileSync(path.join(ROOT, "renderer", "app-boot.js"), "utf8");
  ok(BOOT.indexOf("agentCanvasFreeTrigger") < 0 && BOOT.indexOf("assistCanvasFreeBtn") < 0,
    "app-boot.js 里不再绑定这两个按钮");
  const CSS = fs.readFileSync(path.join(ROOT, "renderer", "css", "assist.css"), "utf8");
  ok(CSS.indexOf(".assist-canvasfree-btn") < 0, "assist.css 里那条按钮样式已删（不留死选择器）");
  const LIGHT = fs.readFileSync(path.join(ROOT, "renderer", "css", "theme-light.css"), "utf8");
  ok(LIGHT.indexOf(".assist-canvasfree-btn") < 0, "theme-light.css 里的亮色覆盖也一并删了");

  console.log("\n[6] AI 自己也要判相关性（宿主关键词档只是省钱的前置闸，判不准仍按有关）");
  ok(ASSIST.indexOf("任务相关性纪律：本轮先自己判断任务是否与画布有关") >= 0,
    "会话人设写明 AI 自己判：无关就别读画布（不调 mtnode_canvas_get）、用文件 / 联网 / 命令把活做完");
  const relLines = ASSIST.split("\n").filter((l) => /相关性：先自己判断本轮任务是否与画布有关/.test(l)).length;
  ok(relLines === 2, "助手人设两条工作范围分支（本画布 / 全局）都写了相关性纪律（得到 " + relLines + " 处）");

  console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过  (smoke-canvas-intent)");
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-canvas-intent.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-canvas-intent.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-canvas-shot-clamp.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-canvas-shot-clamp.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");

  const ROOT = path.join(__dirname, "..");
  const APP = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok  " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };

  /* 取函数体（到下一个顶格 "}" 为止） */
  const fnOf = (name) => {
    const at = APP.indexOf("function " + name + "(");
    if (at < 0) return "";
    const end = APP.indexOf("\n}", at);
    return end > at ? APP.slice(at, end + 2) : "";
  };

  const CLAMP = fnOf("clampCam");
  const EXPORT = fnOf("exportCanvasOverviewPng");

  console.log("[1] clampCam：截图期间不夹相机（右/下边重复内容的直接原因）");
  {
    const head = CLAMP.slice(0, 600);
    ok(/if\s*\(\s*S\._capturingCanvas\s*\)\s*return\s*;/.test(head), "clampCam 开头有 `if (S._capturingCanvas) return;` 守卫");
    const guardAt = head.search(/if\s*\(\s*S\._capturingCanvas\s*\)\s*return\s*;/);
    const clampAt = head.indexOf("const minCamX");
    ok(guardAt >= 0 && clampAt > guardAt, "守卫在夹取逻辑之前（minCamX 计算之前）生效");
  }

  console.log("\n[2] exportCanvasOverviewPng：标志生命周期与瓦片循环");
  {
    ok(EXPORT.length > 0, "找得到 exportCanvasOverviewPng");
    const setOn = EXPORT.indexOf("S._capturingCanvas = true;");
    const loop = EXPORT.indexOf("for (let tx = 0; tx < outW; tx += vw)");
    ok(setOn >= 0 && loop > setOn, "瓦片循环之前置 `S._capturingCanvas = true`");
    const firstTile = EXPORT.indexOf("await captureCanvasTile(");
    ok(firstTile > setOn, "首块截图也在置标志之后（首块相机同样不受夹取影响）");
    ok(/S\._capturingCanvas = false;/.test(EXPORT), "结束前撤标志");
    const body = EXPORT;
    const clearAt = body.indexOf("S._capturingCanvas = false;");
    const restoreAt = body.indexOf("S.cam.x = savedCam.x;");
    ok(clearAt >= 0 && restoreAt > clearAt, "撤标志在恢复视角之前（恢复这一步走常态）");
    ok(
      /finally\s*\{[\s\S]{0,600}?S\._capturingCanvas = false;/.test(body),
      "finally 里兜底撤标志（中途报错也不会让夹取长期失效）",
    );
  }

  console.log("\n[3] 瓦片数学：老逻辑会偏移、新逻辑不偏移（用源码里的真实常数）");
  {
    const mPad = APP.match(/const CAM_PAN_PAD\s*=\s*(\d+)\s*;/);
    const mExportPad = EXPORT.match(/const pad\s*=\s*(\d+)\s*;/);
    const mZMax = APP.match(/const CAM_Z_MAX\s*=\s*([\d.]+)\s*;/);
    const mZMin = APP.match(/const CAM_Z_MIN\s*=\s*([\d.]+)\s*;/);
    ok(!!mPad, "取到 CAM_PAN_PAD");
    ok(!!mExportPad, "取到截图内边距 pad");
    ok(!!mZMax && !!mZMin, "取到 CAM_Z_MIN / CAM_Z_MAX 缩放上限");
    const PAN_PAD = Number(mPad && mPad[1]);
    const PAD = Number(mExportPad && mExportPad[1]);
    const Z_MAX = Number(mZMax && mZMax[1]);
    const Z_MIN = Number(mZMin && mZMin[1]);
    console.log(
      "    常数：CAM_PAN_PAD=" +
        PAN_PAD +
        " · 截图 pad=" +
        PAD +
        " · 缩放 " +
        Z_MIN +
        ".." +
        Z_MAX,
    );

    /* 复刻 exportCanvasOverviewPng 的瓦片循环 + clampCam 的夹取公式 */
    const tiles = (bounds, vw, vh, z, useClamp) => {
      const { minX, minY, maxX, maxY } = bounds;
      const worldW = Math.max(1, maxX - minX + PAD * 2);
      const worldH = Math.max(1, maxY - minY + PAD * 2);
      let s = Math.min(Z_MAX, Math.max(Z_MIN, z));
      const outW = Math.max(1, Math.ceil(worldW * s));
      const outH = Math.max(1, Math.ceil(worldH * s));
      const originX = -(minX - PAD) * s;
      const originY = -(minY - PAD) * s;
      const minCamX = vw - PAN_PAD - maxX * s;
      const maxCamX = PAN_PAD - minX * s;
      const minCamY = vh - PAN_PAD - maxY * s;
      const maxCamY = PAN_PAD - minY * s;
      const clamp = (v, lo, hi) =>
        lo <= hi ? Math.max(lo, Math.min(hi, v)) : (lo + hi) / 2;
      const out = [];
      for (let ty = 0; ty < outH; ty += vh) {
        for (let tx = 0; tx < outW; tx += vw) {
          const want = { x: originX - tx, y: originY - ty };
          const got = useClamp
            ? {
                x: clamp(want.x, minCamX, maxCamX),
                y: clamp(want.y, minCamY, maxCamY),
              }
            : want;
          /* shift > 0 表示该块画面被整体推移（成图上表现为重复/错位内容） */
          out.push({
            tx,
            ty,
            tw: Math.min(vw, outW - tx),
            th: Math.min(vh, outH - ty),
            shiftX: got.x - want.x,
            shiftY: got.y - want.y,
          });
        }
      }
      return out;
    };

    const cases = [
      { name: "宽画布 · 1.0x", bounds: { minX: 0, minY: 0, maxX: 6000, maxY: 900 }, vw: 1200, vh: 620, z: 1 },
      { name: "偏窄画布 · 1.4x", bounds: { minX: 0, minY: 0, maxX: 3944, maxY: 2400 }, vw: 1100, vh: 560, z: 1.4 },
      { name: "负世界坐标 · 0.5x", bounds: { minX: -3000, minY: -800, maxX: 4200, maxY: 2600 }, vw: 1280, vh: 640, z: 0.5 },
      { name: "超宽需多列 · 1.7x", bounds: { minX: 0, minY: 0, maxX: 12000, maxY: 700 }, vw: 1000, vh: 520, z: 1.7 },
    ];

    let oldBad = 0;
    for (const c of cases) {
      const withClamp = tiles(c.bounds, c.vw, c.vh, c.z, true);
      const noClamp = tiles(c.bounds, c.vw, c.vh, c.z, false);
      const oldShift = withClamp.filter((t) => Math.abs(t.shiftX) > 0.5 || Math.abs(t.shiftY) > 0.5);
      const newShift = noClamp.filter((t) => Math.abs(t.shiftX) > 0.5 || Math.abs(t.shiftY) > 0.5);
      oldBad += oldShift.length;
      ok(newShift.length === 0, c.name + "：不夹相机时每块都落在指定位置（无重复）");
      if (oldShift.length) {
        const t = oldShift[0];
        console.log(
          "    老逻辑会偏移 " +
            oldShift.length +
            " 块，例：tx=" +
            t.tx +
            " tw=" +
            t.tw +
            " shiftX=" +
            Math.round(t.shiftX) +
            "px",
        );
      }
    }
    ok(oldBad > 0, "老逻辑（循环里仍夹相机）确实会偏移 → 本 bug 可复现，守卫不是多余的");
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-canvas-shot-clamp)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-canvas-shot-clamp)\n",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-canvas-shot-clamp.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-canvas-shot-clamp.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
