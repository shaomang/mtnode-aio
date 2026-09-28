/**
 * Patch part 3: valueForInput, makeNode, crumb, body UI, resize, menus, tools
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

once(
  nl(
    "function valueForInput(src, idx) {",
    "  if (!src || isControlKind(src)) return null;",
    "  if (src.kind === \"chat\") {",
  ),
  nl(
    "function valueForInput(src, idx) {",
    "  if (!src || isControlKind(src)) return null;",
    "  if (src.kind === \"super\") return valueForSuperOutput(src, idx);",
    "  if (src.kind === \"super_io\") {",
    "    if (src.superIo === \"in\") {",
    "      const host = nodeById(src.parentSuperId);",
    "      return externalValueIntoSuper(host, src.superIoIndex);",
    "    }",
    "    return null;",
    "  }",
    "  if (src.kind === \"chat\") {",
  ),
  "valueForInput",
);

once(
  nl(
    "  node.parentTaskId = currentTaskFocus();",
    "  return node;",
    "}",
    "",
    "function uniqueNodeTitle(desired, exceptId) {",
  ),
  nl(
    "  node.parentTaskId = currentTaskFocus();",
    "  const sf = currentSuperFocus();",
    "  if (sf) {",
    "    node.parentSuperId = sf;",
    "    const host = nodeById(sf);",
    "    node.parentTaskId = host ? host.parentTaskId || \"\" : \"\";",
    "  } else {",
    "    node.parentSuperId = \"\";",
    "  }",
    "  return node;",
    "}",
    "",
    "function uniqueNodeTitle(desired, exceptId) {",
  ),
  "makeNode",
);

once(
  nl(
    "function resetTaskFocus() {",
    "  S.taskFocus = \"\";",
    "  S.taskStack = [];",
    "  renderTaskCrumb();",
    "}",
  ),
  nl(
    "function resetTaskFocus() {",
    "  S.taskFocus = \"\";",
    "  S.taskStack = [];",
    "  resetSuperFocus();",
    "  renderTaskCrumb();",
    "}",
  ),
  "resetTaskFocus",
);

// Extend crumb to show super
once(
  nl(
    "function renderTaskCrumb() {",
    "  const el = $(\"#taskCrumb\");",
    "  if (!el) return;",
    "  const focus = currentTaskFocus();",
    "  if (!focus) {",
    "    el.hidden = true;",
    "    el.innerHTML = \"\";",
    "    return;",
    "  }",
    "  el.hidden = false;",
    "  el.innerHTML = \"\";",
    "  const root = document.createElement(\"button\");",
    "  root.type = \"button\";",
    "  root.className = \"task-crumb-item\";",
    "  root.textContent = I18n.t(\"画布\");",
    "  root.title = I18n.t(\"返回顶层画布\");",
    "  root.onclick = (ev) => {",
    "    ev.stopPropagation();",
    "    setTaskFocus(\"\");",
    "  };",
    "  el.appendChild(root);",
    "  const chain = taskAncestorChain(focus);",
    "  chain.forEach((n, i) => {",
    "    const sep = document.createElement(\"span\");",
    "    sep.className = \"task-crumb-sep\";",
    "    sep.textContent = \"/\";",
    "    el.appendChild(sep);",
    "    const b = document.createElement(\"button\");",
    "    b.type = \"button\";",
    "    b.className =",
    "      \"task-crumb-item\" + (i === chain.length - 1 ? \" on\" : \"\");",
    "    b.textContent = n.title || I18n.t(\"任务\");",
    "    b.title = I18n.t(\"进入任务：\") + (n.title || \"\");",
    "    b.onclick = (ev) => {",
    "      ev.stopPropagation();",
    "      if (i === chain.length - 1) return;",
    "      enterTask(n, { toast: false });",
    "    };",
    "    el.appendChild(b);",
    "  });",
    "  const back = document.createElement(\"button\");",
    "  back.type = \"button\";",
    "  back.className = \"task-crumb-back mini\";",
    "  back.textContent = I18n.t(\"← 返回\");",
    "  back.title = I18n.t(\"返回上一层\");",
    "  back.onclick = (ev) => {",
    "    ev.stopPropagation();",
    "    leaveTask();",
    "  };",
    "  el.appendChild(back);",
    "}",
  ),
  nl(
    "function renderTaskCrumb() {",
    "  const el = $(\"#taskCrumb\");",
    "  if (!el) return;",
    "  const focus = currentTaskFocus();",
    "  const sf = currentSuperFocus();",
    "  if (!focus && !sf) {",
    "    el.hidden = true;",
    "    el.innerHTML = \"\";",
    "    return;",
    "  }",
    "  el.hidden = false;",
    "  el.innerHTML = \"\";",
    "  const root = document.createElement(\"button\");",
    "  root.type = \"button\";",
    "  root.className = \"task-crumb-item\";",
    "  root.textContent = I18n.t(\"画布\");",
    "  root.title = I18n.t(\"返回顶层画布\");",
    "  root.onclick = (ev) => {",
    "    ev.stopPropagation();",
    "    resetSuperFocus();",
    "    setTaskFocus(\"\");",
    "  };",
    "  el.appendChild(root);",
    "  if (focus) {",
    "    const chain = taskAncestorChain(focus);",
    "    chain.forEach((n, i) => {",
    "      const sep = document.createElement(\"span\");",
    "      sep.className = \"task-crumb-sep\";",
    "      sep.textContent = \"/\";",
    "      el.appendChild(sep);",
    "      const b = document.createElement(\"button\");",
    "      b.type = \"button\";",
    "      b.className =",
    "        \"task-crumb-item\" + (!sf && i === chain.length - 1 ? \" on\" : \"\");",
    "      b.textContent = n.title || I18n.t(\"任务\");",
    "      b.title = I18n.t(\"进入任务：\") + (n.title || \"\");",
    "      b.onclick = (ev) => {",
    "        ev.stopPropagation();",
    "        resetSuperFocus();",
    "        enterTask(n, { toast: false });",
    "      };",
    "      el.appendChild(b);",
    "    });",
    "  }",
    "  if (sf) {",
    "    const chain = [];",
    "    let cur = nodeById(sf);",
    "    while (cur && cur.kind === \"super\") {",
    "      chain.unshift(cur);",
    "      cur = nodeById(cur.parentSuperId);",
    "    }",
    "    chain.forEach((n, i) => {",
    "      const sep = document.createElement(\"span\");",
    "      sep.className = \"task-crumb-sep\";",
    "      sep.textContent = \"/\";",
    "      el.appendChild(sep);",
    "      const b = document.createElement(\"button\");",
    "      b.type = \"button\";",
    "      b.className =",
    "        \"task-crumb-item\" + (i === chain.length - 1 ? \" on\" : \"\");",
    "      b.textContent = n.title || I18n.t(\"超级节点\");",
    "      b.title = I18n.t(\"展开超级节点：\") + (n.title || \"\");",
    "      b.onclick = (ev) => {",
    "        ev.stopPropagation();",
    "        enterSuper(n, { toast: false });",
    "      };",
    "      el.appendChild(b);",
    "    });",
    "  }",
    "  const back = document.createElement(\"button\");",
    "  back.type = \"button\";",
    "  back.className = \"task-crumb-back mini\";",
    "  back.textContent = I18n.t(\"← 返回\");",
    "  back.title = I18n.t(\"返回上一层\");",
    "  back.onclick = (ev) => {",
    "    ev.stopPropagation();",
    "    if (currentSuperFocus()) leaveSuper();",
    "    else leaveTask();",
    "  };",
    "  el.appendChild(back);",
    "}",
  ),
  "crumb",
);

// nodeKindLabel
once(
  nl(
    "    music_gen: \"音乐生成\",",
    "    video_gen: \"视频生成\",",
    "  };",
  ),
  nl(
    "    music_gen: \"音乐生成\",",
    "    video_gen: \"视频生成\",",
    "    super: \"超级节点\",",
    "    super_io: \"端口\",",
    "  };",
  ),
  "kindLabel",
);

// agent tool catalog entry
once(
  nl(
    "        {",
    "          key: \"canvas_layout\",",
    "          label: I18n.t(\"排版与成组\"),",
    "          hint: I18n.t(\"自动排版、创建组\"),",
    "        },",
    "      ],",
    "    },",
  ),
  nl(
    "        {",
    "          key: \"canvas_layout\",",
    "          label: I18n.t(\"排版与成组\"),",
    "          hint: I18n.t(\"自动排版、创建组\"),",
    "        },",
    "        {",
    "          key: \"canvas_super\",",
    "          label: I18n.t(\"超级节点\"),",
    "          hint: I18n.t(\"创建超级节点、将节点收纳进子画布（建议审批）\"),",
    "        },",
    "      ],",
    "    },",
  ),
  "tool-catalog",
);

// defaultToolAllow override canvas_super to ask — after defaultToolAllow function
once(
  nl(
    "function defaultToolAllow() {",
    "  const allow = {};",
    "  for (const cat of agentToolCatalog()) {",
    "    for (const it of cat.items) allow[it.key] = \"allow\";",
    "  }",
    "  return allow;",
    "}",
  ),
  nl(
    "function defaultToolAllow() {",
    "  const allow = {};",
    "  for (const cat of agentToolCatalog()) {",
    "    for (const it of cat.items) allow[it.key] = \"allow\";",
    "  }",
    "  allow.canvas_super = \"ask\";",
    "  return allow;",
    "}",
  ),
  "defaultToolAllow",
);

// collectCanvasEditToolKeys — detect super
once(
  nl(
    "  if (doLayout || params.group) keys.add(\"canvas_layout\");",
    "  if (params.setWorkflowName) keys.add(\"app_ops\");",
    "  return keys;",
    "}",
  ),
  nl(
    "  if (doLayout || params.group) keys.add(\"canvas_layout\");",
    "  for (const spec of creates) {",
    "    if (spec && normalizeCanvasCreateKind(spec.kind) === \"super\")",
    "      keys.add(\"canvas_super\");",
    "  }",
    "  for (const spec of updates) {",
    "    if (!spec) continue;",
    "    if (spec.parentSuperId != null || spec.packIntoSuper || spec.note != null)",
    "      keys.add(\"canvas_super\");",
    "    const token = spec.id || spec.alias || spec.title || \"\";",
    "    if (peekKind(token) === \"super\") keys.add(\"canvas_super\");",
    "  }",
    "  if (params.packIntoSuper || params.superId) keys.add(\"canvas_super\");",
    "  if (params.setWorkflowName) keys.add(\"app_ops\");",
    "  return keys;",
    "}",
  ),
  "collectTools",
);

// canvasKindToolKey
once(
  nl(
    "  return isControlKind({ kind: kind }) ? \"canvas_control\" : \"canvas_nodes\";",
    "}",
  ),
  nl(
    "  if (kind === \"super\" || kind === \"super_io\") return \"canvas_super\";",
    "  return isControlKind({ kind: kind }) ? \"canvas_control\" : \"canvas_nodes\";",
    "}",
  ),
  "canvasKindToolKey",
);

fs.writeFileSync(path, s);
console.log("part3 exit", process.exitCode || 0);
