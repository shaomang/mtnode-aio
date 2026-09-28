"use strict";
/* 素材节点（kind "asset"）在 canvas_get 里的回读回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-canvas-asset-get.js
 *
 * 本轮修的 bug：Agent 读画布里的素材节点，节点看起来「空的」——
 *   ① canvas_get 的快照序列化里根本没有 asset 分支：assetId / assetName / assetRel /
 *      assetDesc / items（条目清单）一个都不在返回里，模型只看见几条线凭空接在一个
 *      没有任何内容的节点上；
 *   ② 端子表（ports）只给「端子数固定」的那几类，asset 不在名单里 —— 素材节点的
 *      端子号 = 内容条目号、端子名 = 条目标题，这些关键信息一个都读不到；
 *   ③ 条目正文只存在素材库里（节点上只有条目身份），full 档也不补读 ——
 *      于是 agent 只能去应用数据目录翻文件。
 * 本测试钉住修好后的口径：
 *   [1] 条目清单与端子表进快照：assetItems / ports（名称 = 条目标题、类型 = 条目类型、
 *       占用按连线），minimal 档不带（每轮重发必须最轻）；
 *   [2] 正文档位纪律：standard 只给清单，full / bodies:true 才有正文（文本 inline ·
 *       媒体给本机路径），bodyLimit 照其它正文截断且 textLen 恒为真长度；
 *   [3] 失联条目如实报 missing，不抛不吞；contentHash 由同一份快照算出（结构 + 正文）；
 *   [4] 工具描述写明素材节点的回读形状（模型要知道去哪读，而不是去翻文件系统）。
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
  process.exit(fails ? 1 : 0);
})();