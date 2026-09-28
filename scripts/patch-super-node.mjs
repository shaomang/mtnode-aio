/**
 * Patch super-node into renderer/app.js (CRLF-safe)
 */
import fs from "fs";

const path = "E:/dev/tools/pipeline-console/renderer/app.js";
let s = fs.readFileSync(path, "utf8");

function once(from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) {
    console.error("MISS", label);
    process.exitCode = 1;
    return false;
  }
  if (s.indexOf(from, i + from.length) >= 0) {
    console.error("MULTI", label);
    process.exitCode = 1;
    return false;
  }
  s = s.slice(0, i) + to + s.slice(i + from.length);
  console.log("OK", label);
  return true;
}

function nl(strings) {
  // join with detected newline from file
  const N = s.includes("\r\n") ? "\r\n" : "\n";
  return strings.join(N);
}

once(
  nl(["  video_gen: \"video\",", "};"]),
  nl(["  video_gen: \"video\",", "  super: \"super\",", "  super_io: \"super-io\",", "};"]),
  "KIND_CLS",
);

once(
  nl([
    "  task: {",
    "    w: 320,",
    "    h: 280,",
    "    title: \"任务\",",
    "    goal: \"\",",
    "    steps: [],",
    "    parentTaskId: \"\",",
    "    taskStatus: \"pending\",",
    "    output: null,",
    "    error: null,",
    "    ranAt: 0,",
    "    running: false,",
    "  },",
  ]),
  nl([
    "  task: {",
    "    w: 320,",
    "    h: 280,",
    "    title: \"任务\",",
    "    goal: \"\",",
    "    steps: [],",
    "    parentTaskId: \"\",",
    "    taskStatus: \"pending\",",
    "    output: null,",
    "    error: null,",
    "    ranAt: 0,",
    "    running: false,",
    "  },",
    "  super: {",
    "    w: 280,",
    "    h: 200,",
    "    title: \"超级节点\",",
    "    note: \"\",",
    "    expandW: 720,",
    "    expandH: 480,",
    "    superOpen: false,",
    "    parentTaskId: \"\",",
    "    parentSuperId: \"\",",
    "  },",
    "  super_io: {",
    "    w: 132,",
    "    h: 72,",
    "    title: \"端口\",",
    "    superIo: \"in\",",
    "    superIoIndex: 0,",
    "    parentTaskId: \"\",",
    "    parentSuperId: \"\",",
    "    pinned: true,",
    "  },",
  ]),
  "NODE_DEFAULTS",
);

once(
  nl([
    "function currentTaskFocus() {",
    "  return S.taskFocus || \"\";",
    "}",
    "function nodeParentTaskId(n) {",
    "  return (n && n.parentTaskId) || \"\";",
    "}",
    "function markParentTaskId(m) {",
    "  return (m && m.parentTaskId) || \"\";",
    "}",
    "function nodeInCurrentScope(n) {",
    "  return !!n && nodeParentTaskId(n) === currentTaskFocus();",
    "}",
    "function markInCurrentScope(m) {",
    "  return !!m && markParentTaskId(m) === currentTaskFocus();",
    "}",
    "function visibleWfNodes() {",
    "  return ((S.wf && S.wf.nodes) || []).filter(nodeInCurrentScope);",
    "}",
    "function visibleMarks() {",
    "  return marksOf().filter(markInCurrentScope);",
    "}",
    "function taskChildrenOf(id) {",
    "  if (!id || !S.wf) return [];",
    "  return (S.wf.nodes || []).filter((n) => n.parentTaskId === id);",
    "}",
  ]),
  nl([
    "function currentTaskFocus() {",
    "  return S.taskFocus || \"\";",
    "}",
    "function currentSuperFocus() {",
    "  return S.superFocus || \"\";",
    "}",
    "function nodeParentTaskId(n) {",
    "  return (n && n.parentTaskId) || \"\";",
    "}",
    "function nodeParentSuperId(n) {",
    "  return (n && n.parentSuperId) || \"\";",
    "}",
    "function markParentTaskId(m) {",
    "  return (m && m.parentTaskId) || \"\";",
    "}",
    "function markParentSuperId(m) {",
    "  return (m && m.parentSuperId) || \"\";",
    "}",
    "function nodeInCurrentScope(n) {",
    "  if (!n) return false;",
    "  const sf = currentSuperFocus();",
    "  if (sf) return nodeParentSuperId(n) === sf;",
    "  if (nodeParentSuperId(n)) return false;",
    "  return nodeParentTaskId(n) === currentTaskFocus();",
    "}",
    "function markInCurrentScope(m) {",
    "  if (!m) return false;",
    "  const sf = currentSuperFocus();",
    "  if (sf) return markParentSuperId(m) === sf;",
    "  if (markParentSuperId(m)) return false;",
    "  return markParentTaskId(m) === currentTaskFocus();",
    "}",
    "function visibleWfNodes() {",
    "  return ((S.wf && S.wf.nodes) || []).filter(nodeInCurrentScope);",
    "}",
    "function visibleMarks() {",
    "  return marksOf().filter(markInCurrentScope);",
    "}",
    "function taskChildrenOf(id) {",
    "  if (!id || !S.wf) return [];",
    "  return (S.wf.nodes || []).filter((n) => n.parentTaskId === id);",
    "}",
    "function superChildrenOf(id) {",
    "  if (!id || !S.wf) return [];",
    "  return (S.wf.nodes || []).filter((n) => n.parentSuperId === id);",
    "}",
    "function isSuperNode(n) {",
    "  return !!(n && n.kind === \"super\");",
    "}",
    "function isSuperIoNode(n) {",
    "  return !!(n && n.kind === \"super_io\");",
    "}",
    "function superDisplaySize(n) {",
    "  if (!n || n.kind !== \"super\")",
    "    return { w: (n && n.w) || 240, h: (n && n.h) || 160 };",
    "  if (n.superOpen && !currentSuperFocus()) {",
    "    return {",
    "      w: Math.max(320, Number(n.expandW) || 720),",
    "      h: Math.max(220, Number(n.expandH) || 480),",
    "    };",
    "  }",
    "  return { w: n.w || 280, h: n.h || 200 };",
    "}",
  ]),
  "scope-helpers",
);

once(
  nl([
    "  /* 任务节点「进入」：只显示 parentTaskId === taskFocus 的节点 */",
    "  taskFocus: \"\",",
    "  taskStack: [],",
  ]),
  nl([
    "  /* 任务节点「进入」：只显示 parentTaskId === taskFocus 的节点 */",
    "  taskFocus: \"\",",
    "  taskStack: [],",
    "  /* 超级节点内部：只显示 parentSuperId === superFocus 的节点 */",
    "  superFocus: \"\",",
    "  superStack: [],",
  ]),
  "state",
);

fs.writeFileSync(path, s);
console.log("done exit", process.exitCode || 0);
