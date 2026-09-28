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
  process.exit(0);
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
process.exit(fails ? 1 : 0);
