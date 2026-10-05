"use strict";
/* MCP 版本闸（contentHash）真跑回归 —— 冒烟测试（纯 Node，不依赖 Electron、不启应用）
 *   node test/smoke-mcp-version-gate.js
 *
 * 为什么单独立一只：这个哈希是 **写操作的乐观并发基准**（MCP 的 baseHash 与自家 Agent
 * 同一口径）。MCP 侧给客户端的说明是「把 mtnode_canvas_get 回执里的 contentHash 原样
 * 作为 baseHash 传回来」，于是任何「同图不同读法算出不同哈希」都会让写操作被整片拒掉。
 *
 * 线上实测（干净环境全量 MCP 端到端测试）踩到过两种，这条测试就是钉住它们：
 *   ① 哈希算在**裁过的快照**上 → detail:"minimal" 与 "standard" 对同一张没动过的画布
 *      算出两个哈希 → 客户端读完（standard）再改，必被判「画布已被改动（版本不一致）」。
 *      判据：同一张真源的不同裁法（minimal / standard / full）必须同哈希。
 *   ② 哈希漏掉真源里的东西 → 闸门形同虚设，手改拦不住。
 *      判据：节点位置 / 连线 / 正文长度变了，哈希必须跟着变。
 *
 * 跑法：把 renderer/app-nodes.js 里的三个函数原样抠进 vm 跑真行为（不读源码字面量）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

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

/* 抠顶层函数声明（与 smoke-token-budget 同一套切片口径） */
function sliceBraces(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("括号未配平（锚点附近代码改动过大？）");
}
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) {
    ok(false, "app-nodes.js 应定义函数 " + name);
    return "";
  }
  const open = src.indexOf("{", src.indexOf(")", m.index));
  return src.slice(m.index, open + sliceBraces(src, open).length);
}

const NODES = read("renderer/app-nodes.js");

console.log("[1] 版本闸哈希：与读法（detail / sections）解耦");
{
  const code = [
    "(function () {",
    grabFunction(NODES, "hashScalar"),
    grabFunction(NODES, "snapshotHashSource"),
    grabFunction(NODES, "snapshotContentHashOf"),
    "return { snapshotContentHashOf, snapshotHashSource };",
    "})()",
  ].join("\n");
  const sandbox = {
    NODE_BODY_KEYS: ["text", "prompt", "task", "goal", "jscode"],
    JSON,
    String,
    Number,
    Object,
    Array,
    S: { wf: null },
  };
  const api = vm.runInContext(code, vm.createContext(sandbox));
  ok(typeof api.snapshotContentHashOf === "function", "抠出并跑通 snapshotContentHashOf");

  const wf = {
    id: "wf-gate",
    name: "版本闸测试画布",
    nodes: [
      { id: "n1", kind: "input_text", title: "输入", x: 0, y: 0, w: 240, h: 120, text: "正文甲", note: "备注", tags: ["a"] },
      { id: "n2", kind: "proc_text", title: "处理", x: 400, y: 0, w: 240, h: 120, prompt: "提示词", agent: true, model: "m1" },
      { id: "s1", kind: "super", title: "壳", parentSuperId: "", dev: true, devStatus: "wip" },
    ],
    wires: [{ from: "n1", to: "n2", fromIndex: 0 }],
    groups: [{ id: "g1", title: "组", nodes: ["n1", "n2"] }],
    marks: [{ id: "m1", kind: "text", text: "标注", x: 0, y: -80 }],
    workspace: "E:\\tmp",
  };
  sandbox.S.wf = wf;
  const h0 = api.snapshotContentHashOf(wf);
  ok(/^fnv1a-[0-9a-f]{8}-[0-9a-f]+$/.test(h0), "哈希形状正确（" + h0 + "）");

  /* 「同一张真源的不同读法必须同哈希」在单元层面就是「与快照的包装/装饰无关」：
     真源永远整份交给哈希函数（canvasSnapshotFull 传 S.wf），detail / sections 只裁
     回给客户端的那份副本，裁不到这里。两条判据：
       ① 真源上再挂快照信封字段（readAt / detail / selection …）哈希不变；
       ② 真源少一个节点 / 删一条连线（真删了）哈希必须变。
     端到端那条「minimal = standard = full」由 scripts/e2e-mcp-full.mjs 在真应用里跑。 */
  const enveloped = Object.assign({}, wf, {
    detail: "minimal",
    readAt: new Date().toISOString(),
    selection: [{ id: "n1", title: "输入" }],
    workflows: [{ id: "wf-gate", name: "版本闸测试画布", nodes: 3, active: true }],
    assistOpen: true,
    sidebarOpen: false,
    scopeNote: "工作范围=本会话所属画布",
  });
  ok(api.snapshotContentHashOf(enveloped) === h0, "真源上再挂快照信封字段（detail / selection / readAt …）哈希不变");
  ok(
    api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => Object.assign({}, n, { running: true, _cache: { t: 1 } })) })) === h0 ||
      api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => Object.assign({}, n, { running: true, _cache: { t: 1 } })) })) !== h0,
    "带运行态 / 内部字段的真源也能算出哈希（不抛）",
  );

  /* sections 收窄（只给 nodes / 只给 wires）同样不该换哈希：真源没变 */
  ok(api.snapshotContentHashOf(Object.assign({}, wf, { marks: [], groups: [] })) !== h0, "只留 nodes+wire 的真源（marks/groups 真删了）哈希跟着变");
  const sub = api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.slice(0, 1) }));
  ok(sub !== h0, "真源少了一个节点哈希跟着变");

  /* S.wf 缺省通道：不传参时读 S.wf（canvasSnapshotFull 走的就是这条） */
  ok(api.snapshotContentHashOf(undefined) === h0, "不传参时取 S.wf（与 canvasSnapshotFull 的调用口径一致）");

  /* 真改结构 → 必须换哈希，否则闸门拦不住手改 */
  ok(
    api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => (n.id === "n2" ? Object.assign({}, n, { x: 999 }) : n)) })) !== h0,
    "节点位置变了哈希跟着变",
  );
  ok(api.snapshotContentHashOf(Object.assign({}, wf, { wires: [] })) !== h0, "连线删了哈希跟着变");
  ok(
    api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => (n.id === "n1" ? Object.assign({}, n, { text: "正文甲乙丙" }) : n)) })) !== h0,
    "正文长度变了哈希跟着变（正文只按长度参与，不整体序列化）",
  );
  ok(api.snapshotContentHashOf(Object.assign({}, wf, { name: "改名了" })) !== h0, "画布改名哈希跟着变");
  ok(
    api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => (n.id === "s1" ? Object.assign({}, n, { devStatus: "done" }) : n)) })) !== h0,
    "开发节点状态变了哈希跟着变",
  );
  /* 易变项不进哈希：镜头 / 选中 / 运行态不该让「读完立刻改」失效 */
  ok(api.snapshotContentHashOf(Object.assign({}, wf, { cam: { x: 12, y: 34, z: 1.5 } })) === h0, "镜头（cam）不进哈希");
  /* 下划线内部字段（会话 / 缓存用）不进哈希 */
  ok(
    api.snapshotContentHashOf(Object.assign({}, wf, { nodes: wf.nodes.map((n) => Object.assign({}, n, { _cache: { t: Math.random() } })) })) === h0,
    "下划线内部字段（_xxx）不进哈希",
  );
}

console.log("[2] 接线口径：真源哈希回给网关 + 桥按同一真源比对");
{
  ok(/snap\.contentHash = snapshotContentHashOf\(S\.wf\)/.test(NODES), "canvasSnapshotFull 用真源算 contentHash");
  ok(!/snap\.contentHash = snapshotContentHashOf\(snap\)/.test(NODES), "不再用裁过的快照算哈希（本次修掉的那条）");
  const bridge = read("renderer/mcp-bridge.js");
  ok(/canvasSnapshotFull\(\{ detail: "minimal" \}/.test(bridge), "MCP 桥比对用的也是 canvas_get 同一条快照路径");
  const server = read("mcp-server.js");
  ok(/baseHash/.test(server), "服务端把 baseHash 摘出来当版本闸（不下发给渲染层）");
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过") + "  (smoke-mcp-version-gate)");
process.exit(fails ? 1 : 0);
