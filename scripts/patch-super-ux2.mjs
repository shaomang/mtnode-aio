/**
 * Super UX v2: no super_io, hover-expand, inner grid, resize fix
 */
import fs from "fs";

const path = "E:/dev/tools/pipeline-console/renderer/app.js";
let s = fs.readFileSync(path, "utf8");
const N = s.includes("\r\n") ? "\r\n" : "\n";
const nl = (...lines) => lines.join(N);

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

function replaceAll(from, to, label) {
  if (!s.includes(from)) {
    console.error("MISS", label);
    process.exitCode = 1;
    return false;
  }
  const n = s.split(from).length - 1;
  s = s.split(from).join(to);
  console.log("OK", label, "x" + n);
  return true;
}

/* ---- helpers after findOpenSuperAtWorld ---- */
once(
  nl(
    "function findOpenSuperAtWorld(x, y, exceptIds) {",
    "  const skip = exceptIds || new Set();",
    "  let best = null;",
    "  let bestArea = Infinity;",
    "  for (const n of (S.wf && S.wf.nodes) || []) {",
    "    if (!n || n.kind !== \"super\" || !n.superOpen) continue;",
    "    if (skip.has(n.id)) continue;",
    "    if (nodeParentTaskId(n) !== currentTaskFocus()) continue;",
    "    if (currentSuperFocus()) continue;",
    "    const sz = superDisplaySize(n);",
    "    const o = superInnerOrigin(n);",
    "    const x0 = n.x + o.ox;",
    "    const y0 = n.y + o.oy;",
    "    const x1 = n.x + sz.w - 8;",
    "    const y1 = n.y + sz.h - 10;",
    "    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {",
    "      const area = sz.w * sz.h;",
    "      if (area < bestArea) {",
    "        best = n;",
    "        bestArea = area;",
    "      }",
    "    }",
    "  }",
    "  return best;",
    "}",
  ),
  nl(
    "function findOpenSuperAtWorld(x, y, exceptIds) {",
    "  const skip = exceptIds || new Set();",
    "  let best = null;",
    "  let bestArea = Infinity;",
    "  for (const n of (S.wf && S.wf.nodes) || []) {",
    "    if (!n || n.kind !== \"super\" || !n.superOpen) continue;",
    "    if (skip.has(n.id)) continue;",
    "    if (nodeParentTaskId(n) !== currentTaskFocus()) continue;",
    "    if (currentSuperFocus()) continue;",
    "    const sz = superDisplaySize(n);",
    "    const o = superInnerOrigin(n);",
    "    const x0 = n.x + o.ox;",
    "    const y0 = n.y + o.oy;",
    "    const x1 = n.x + sz.w - 8;",
    "    const y1 = n.y + sz.h - 10;",
    "    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {",
    "      const area = sz.w * sz.h;",
    "      if (area < bestArea) {",
    "        best = n;",
    "        bestArea = area;",
    "      }",
    "    }",
    "  }",
    "  return best;",
    "}",
    "function findSuperShellAtWorld(x, y, exceptIds) {",
    "  const skip = exceptIds || new Set();",
    "  let best = null;",
    "  let bestArea = Infinity;",
    "  for (const n of (S.wf && S.wf.nodes) || []) {",
    "    if (!n || n.kind !== \"super\") continue;",
    "    if (skip.has(n.id)) continue;",
    "    if (nodeParentTaskId(n) !== currentTaskFocus()) continue;",
    "    if (currentSuperFocus()) continue;",
    "    const sz = superDisplaySize(n);",
    "    if (x >= n.x && x <= n.x + sz.w && y >= n.y && y <= n.y + sz.h) {",
    "      const area = sz.w * sz.h;",
    "      if (area < bestArea) {",
    "        best = n;",
    "        bestArea = area;",
    "      }",
    "    }",
    "  }",
    "  return best;",
    "}",
    "function isInsideSuper(n, superId) {",
    "  return !!(n && superId && nodeParentSuperId(n) === superId);",
    "}",
    "function superExternalInWires(superId) {",
    "  return ((S.wf && S.wf.wires) || []).filter((w) => {",
    "    if (w.to !== superId || wireFromIsControl(w)) return false;",
    "    return !isInsideSuper(nodeById(w.from), superId);",
    "  });",
    "}",
    "function superInternalOutFeeds(superId) {",
    "  return ((S.wf && S.wf.wires) || []).filter((w) => {",
    "    if (w.to !== superId || wireFromIsControl(w)) return false;",
    "    return isInsideSuper(nodeById(w.from), superId);",
    "  });",
    "}",
    "function superExternalOutWires(superId) {",
    "  return ((S.wf && S.wf.wires) || []).filter((w) => {",
    "    if (w.from !== superId || wireFromIsControl(w)) return false;",
    "    return !isInsideSuper(nodeById(w.to), superId);",
    "  });",
    "}",
    "function stripSuperIoNodes(wf) {",
    "  wf = wf || S.wf;",
    "  if (!wf || !Array.isArray(wf.nodes)) return;",
    "  const ios = (wf.nodes || []).filter(isSuperIoNode);",
    "  if (!ios.length) return;",
    "  const meta = new Map();",
    "  for (const io of ios) {",
    "    meta.set(io.id, {",
    "      host: io.parentSuperId,",
    "      role: io.superIo === \"out\" ? \"out\" : \"in\",",
    "      index: Math.max(0, Math.round(Number(io.superIoIndex) || 0)),",
    "    });",
    "  }",
    "  const drop = new Set();",
    "  for (const w of wf.wires || []) {",
    "    const fromIo = meta.get(w.from);",
    "    const toIo = meta.get(w.to);",
    "    if (fromIo && fromIo.role === \"in\") {",
    "      w.from = fromIo.host;",
    "      w.fromIndex = fromIo.index;",
    "    } else if (fromIo) {",
    "      drop.add(w.id);",
    "    }",
    "    if (toIo && toIo.role === \"out\") {",
    "      w.to = toIo.host;",
    "      w.toIndex = toIo.index;",
    "    } else if (toIo) {",
    "      drop.add(w.id);",
    "    }",
    "  }",
    "  wf.wires = (wf.wires || []).filter((w) => !drop.has(w.id) && !meta.has(w.from) && !meta.has(w.to));",
    "  wf.nodes = (wf.nodes || []).filter((n) => !isSuperIoNode(n));",
    "}",
    "function clearSuperDropHot() {",
    "  document.querySelectorAll(\".wf-node.super.super-drop-hot\").forEach((el) => {",
    "    el.classList.remove(\"super-drop-hot\");",
    "  });",
    "  S._superDropHotId = \"\";",
    "}",
    "function setSuperDropHot(id) {",
    "  if (S._superDropHotId === id) return;",
    "  clearSuperDropHot();",
    "  if (!id) return;",
    "  S._superDropHotId = id;",
    "  const el = document.querySelector('.wf-node[data-nid=\"' + id + '\"]');",
    "  if (el) el.classList.add(\"super-drop-hot\");",
    "}",
    "function updateSuperHoverExpand(ev, dragIds) {",
    "  if (currentSuperFocus()) {",
    "    clearSuperDropHot();",
    "    return;",
    "  }",
    "  const skip = new Set(dragIds || []);",
    "  for (const id of dragIds || []) {",
    "    const n = nodeById(id);",
    "    if (n && n.kind === \"super\") skip.add(id);",
    "  }",
    "  const pt = toStage(ev.clientX, ev.clientY);",
    "  const host = findSuperShellAtWorld(pt.x, pt.y, skip);",
    "  if (!host) {",
    "    clearSuperDropHot();",
    "    return;",
    "  }",
    "  let needRender = false;",
    "  if (!host.superOpen) {",
    "    host.superOpen = true;",
    "    S._superHoverOpened = S._superHoverOpened || new Set();",
    "    S._superHoverOpened.add(host.id);",
    "    needRender = true;",
    "  }",
    "  if (needRender) {",
    "    renderCanvas();",
    "    const z = S.cam.z > 0 ? S.cam.z : 1;",
    "    const d = S.drag;",
    "    if (d && d.mode === \"node\" && d.orig) {",
    "      const dx = (ev.clientX - d.sx) / z;",
    "      const dy = (ev.clientY - d.sy) / z;",
    "      for (const id of d.ids || []) {",
    "        const n = nodeById(id);",
    "        const o = d.orig[id];",
    "        if (!n || !o) continue;",
    "        n.x = snap(o.x + dx);",
    "        n.y = snap(o.y + dy);",
    "        const el = document.querySelector('.wf-node[data-nid=\"' + id + '\"]');",
    "        if (el) {",
    "          el.style.left = n.x + \"px\";",
    "          el.style.top = n.y + \"px\";",
    "        }",
    "      }",
    "    }",
    "  }",
    "  setSuperDropHot(host.id);",
    "}",
    "function syncSuperStageGrid(stageEl) {",
    "  if (!stageEl) return;",
    "  const g = grid();",
    "  stageEl.style.setProperty(\"--super-grid-size\", g + \"px\");",
    "  stageEl.style.setProperty(\"--super-grid-x\", \"0px\");",
    "  stageEl.style.setProperty(\"--super-grid-y\", \"0px\");",
    "}",
  ),
  "hover-helpers",
);

/* remove ensureSuperIoPorts calls */
replaceAll("ensureSuperIoPorts(host);\r\n", "", "rm-ensure-host-crlf");
replaceAll("ensureSuperIoPorts(host);\n", "", "rm-ensure-host-lf");
replaceAll("    ensureSuperIoPorts(n);\r\n", "", "rm-ensure-n-crlf");
replaceAll("    ensureSuperIoPorts(n);\n", "", "rm-ensure-n-lf");
replaceAll("ensureSuperIoPorts(superNode);\r\n", "", "rm-ensure-sn-crlf");
replaceAll("ensureSuperIoPorts(superNode);\n", "", "rm-ensure-sn-lf");
replaceAll("            if (node.superOpen) ensureSuperIoPorts(node);\r\n", "", "rm-ctx-crlf");
replaceAll("            if (node.superOpen) ensureSuperIoPorts(node);\n", "", "rm-ctx-lf");
replaceAll("        ensureSuperIoPorts(node);\r\n", "", "rm-expand-crlf");
replaceAll("        ensureSuperIoPorts(node);\n", "", "rm-expand-lf");
replaceAll(
  "    if (node && node.kind === \"super\") ensureSuperIoPorts(node);\r\n",
  "",
  "rm-agent-crlf",
);
replaceAll(
  "    if (node && node.kind === \"super\") ensureSuperIoPorts(node);\n",
  "",
  "rm-agent-lf",
);
replaceAll("  if (kind === \"super\") ensureSuperIoPorts(node);\r\n", "", "rm-add-crlf");
replaceAll("  if (kind === \"super\") ensureSuperIoPorts(node);\n", "", "rm-add-lf");

/* replace ensureSuperIoPorts + findSuperIo + value bridge */
once(
  nl(
    "function ensureSuperIoPorts(superNode, wf) {",
  ),
  nl(
    "function ensureSuperIoPorts(_superNode, _wf) {",
    "  /* removed: edge ports replace inner 输入/输出 nodes */",
    "}",
    "function __removed_ensureSuperIoPorts_BODY(superNode, wf) {",
  ),
  "stub-ensure",
);

/* The above leaves broken code - better approach: replace the whole function body properly.
   Let me read what we have now and fix differently. */

fs.writeFileSync(path, s);
console.log("partial exit", process.exitCode || 0);
