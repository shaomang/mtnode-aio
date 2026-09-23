"use strict";
/* 一次性取证：把 smoke-token-budget [10] 的沙箱复刻出来，逐节点看 portRule 到底回了什么。只读。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const read = (rel) => fs.readFileSync(path.join(__dirname, rel.split("/").join(path.sep)), "utf8");
const readN = (rel) => read(rel).replace(/\r\n?/g, "\n");
const NODES_SRC = readN("renderer/app-nodes.js");
const I18N = require(path.join(__dirname, "renderer", "i18n.js"));

function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced");
}
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("missing " + name);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  return src.slice(m.index, open + sliceBraces(src, open).length);
}
function grabStringList(src, name) {
  const m = new RegExp("const " + name + "\\s*=\\s*\\[[^\\]]*\\]", "m").exec(src);
  if (!m) throw new Error("missing " + name);
  return (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
}
const SNAPSHOT_PORT_KINDS = grabStringList(NODES_SRC, "SNAPSHOT_PORT_KINDS");
const PORT_WF = {
  nodes: [
    { id: "up", kind: "proc_text", title: "上游" },
    { id: "vid", kind: "video_gen", title: "视频" },
    { id: "rem", kind: "remotion", title: "动效" },
    { id: "pi", kind: "proc_image", title: "图" },
    { id: "ag", kind: "agent_task", title: "智能" },
    { id: "sv", kind: "save", title: "存" },
    { id: "as", kind: "asset", title: "素材", items: [{ id: "i1", title: "开场白", type: "text" }] },
  ],
  wires: [],
};
const CONTROL_KINDS = ["control", "wait_file", "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex", "judge", "task"];
const ctx = vm.createContext({
  S: { wf: PORT_WF },
  nodeById: (id) => PORT_WF.nodes.filter((n) => n.id === id)[0] || null,
  inputCount: (n) => (n.kind === "asset" ? (n.items || []).length : n.kind === "video_gen" ? 4 : ["remotion", "proc_image"].indexOf(n.kind) >= 0 ? 2 : 1),
  outputCount: (n) => (n.kind === "asset" ? (n.items || []).length : 1),
  isFnToolNode: () => false,
  isAssetNode: (n) => !!(n && n.kind === "asset"),
  isControlKind: (n) => CONTROL_KINDS.indexOf(String((n && n.kind) || "")) >= 0,
  SNAPSHOT_PORT_KINDS,
  I18n: { t: (k) => I18N.t(k) },
  String, Object, Array, JSON, Number, Math, Set, RegExp, Error, console,
});
const api = vm.runInContext(
  [
    "(function () {",
    grabFunction(NODES_SRC, "snapshotHasFixedPorts"),
    grabFunction(NODES_SRC, "snapshotInputGrowsWithWires"),
    grabFunction(NODES_SRC, "snapshotDynamicPortRule"),
    "return { snapshotHasFixedPorts, snapshotInputGrowsWithWires, snapshotDynamicPortRule };",
    "})()",
  ].join("\n"),
  ctx,
  { filename: "probe" },
);
for (const n of PORT_WF.nodes) {
  const r = api.snapshotDynamicPortRule(n);
  console.log(
    n.id.padEnd(4), String(n.kind).padEnd(12),
    "fixed=" + api.snapshotHasFixedPorts(n),
    "grows=" + api.snapshotInputGrowsWithWires(n),
    "rule=" + (r ? "YES in=" + r.now.in + " out=" + r.now.out : "undefined"),
  );
}