"use strict";
/* ============ 顶栏「工具库」：跨画布保存 / 插入 / 管理 ============
 * 「工具库」按钮＝打开本对话框：只列本机已保存的工具包 / 函数包（保存 / 插入 / 改名 /
 * 删除 / 随时可调用开关）。工具节点与函数节点的**创建**入口不在这里，和普通节点一样在
 * 画布右键菜单的「工具」一级菜单下（app.js · canvasCreateMenuGroups）。
 * 工具节点（规范形态＝超级节点变体 super + tool:true，判定唯一真源 isToolNode()；
 * 旧存档 / 旧工具包里的普通 kind "tool" 在加载与插入时经 migrateToolNodeToSuperForm()
 * 一次性原地转成该变体）可保存为「完整工具包」：工具定义（名称 / 描述 / 入出参数）+
 * 内部图 JSON 快照（graph = { rootId, nodes, wires }），经主进程 tools-store.js 落盘
 * <数据目录>/tools/<id>.json；插入到任意画布即用（克隆为新 id / 标题唯一化 /
 * 内部父子归属与连线按新 id 重建，运行现场字段清空）。
 *
 * 「会话随时可调用」（always）开关默认关，供 Agent 工具调用链路（func call）消费；
 * 打开时 Agent 可在会话中直接调用该工具，关闭时仅在画布内可运行。
 *
 * 本文件依赖 app.js 的节点判定 / 克隆工具与通用对话框；加载顺序在 app-plugins.js
 * 之后、app-boot.js 之前（顶栏接线在 app-boot.js，见 btnTools）。
 * ─────────────────────────────────────────────────────────────────── */

function toolsApiOk() {
  return !!(window.api && typeof window.api.toolsList === "function");
}

/* 从当前画布的工具 / 函数节点抓完整工具包：定义（名称 / 描述 / 入出参数）+ 内部图快照
   （该节点 + 全部后代 + 两端都在集合内的连线，跨画布专用外部连线不收录）。
   函数节点＝单节点图（无后代、无内部连线）：存档格式与工具包同一份，只用 kind 区分，
   老包没有 kind 字段 → 读取方一律按「非 function 即 tool」处理（见 toolEntryKind）。 */
function toolPackageFromNode(node) {
  if (!node || !isFnToolNode(node)) return null;
  const isFn = isFunctionNode(node);
  ensureFnToolNodeState(node);
  const c = isFn
    ? { name: node.fnName || "", description: node.description || "" }
    : node.toolConfig || {};
  const srcs = collectWithDescendants([node]);
  if (!srcs.length) return null;
  const ids = new Set(srcs.map((n) => n.id));
  const wires = (S.wf.wires || []).filter(
    (w) => ids.has(w.from) && ids.has(w.to),
  );
  const mkParams = (dir) =>
    fnToolParamList(node, dir).map((p) => ({
      name: String(p.name || ""),
      kind: p.kind === "image" ? "image" : "text",
    }));
  return {
    id: String(node.toolLibId || ""),
    kind: isFn ? "function" : "tool",
    name: String(c.name || "").trim(),
    description: String(c.description || ""),
    inputs: mkParams("in"),
    outputs: mkParams("out"),
    /* 「会话随时可调用」只对工具节点有意义（Agent func call 执行链跑的是工具的内部图），
       函数条目恒 false —— 清单里也不给它这个开关 */
    always: isFn ? false : !!node.toolAlways,
    graph: {
      rootId: node.id,
      nodes: srcs.map((n) => JSON.parse(JSON.stringify(n))),
      wires: wires.map((w) => JSON.parse(JSON.stringify(w))),
    },
  };
}

/* 工具库条目 → 类型（"tool" / "function"）：优先读条目上显式的 kind；老包没有该字段
   （或清单不带）时按内部图根节点的 kind 推断 —— 函数节点＝kind "function"，工具节点＝
   kind "super" + tool:true（或旧形态 kind "tool"）。清单徽标与「不进 Agent 可调用清单」都用它。 */
function toolEntryKind(entry) {
  const k = String((entry && entry.kind) || "");
  if (k === "function" || k === "tool") return k;
  const g = (entry && entry.graph) || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rootId = String(g.rootId || "");
  const root =
    nodes.find((n) => n && String(n.id || "") === rootId) || nodes[0] || null;
  return root && root.kind === "function" ? "function" : "tool";
}

/* 名称写回（保存 / 改名共用 · 与节点头部「设置」面板同口径）：工具节点走
   applyToolConfigName（标题仍是默认「工具N」时跟随改名），函数节点写 fnName
   （标题仍是默认「函数N」时一并同步）。 */
function applyFnLibName(node, name) {
  if (!node || !isFnToolNode(node)) return;
  const next = String(name == null ? "" : name).trim();
  if (!isFunctionNode(node)) {
    applyToolConfigName(node, next);
    return;
  }
  ensureFnToolNodeState(node);
  const old = String(node.fnName || "");
  const titleNow = String(node.title || "");
  node.fnName = next;
  if (
    next &&
    (titleNow === old || (!old && /^函数(\s*\d+)?$/.test(titleNow))) &&
    titleNow !== next
  )
    node.title = uniqueNodeTitle(next, node.id);
}

/* 把当前画布的工具节点 / 函数节点保存到工具库（同名存在 → 先确认覆盖；未命名 → 先问名字） */
async function saveToolFromCanvas(node) {
  const api = window.api;
  if (!api || !node || !isFnToolNode(node)) return { ok: false };
  const isFn = isFunctionNode(node);
  ensureFnToolNodeState(node);
  let c = node.toolConfig || {};
  let name = isFn
    ? String(node.fnName || node.title || "").trim()
    : String(c.name || "").trim();
  if (!name) {
    const hint = String(node.title || "")
      .replace(/^(工具|函数)\s*\d*$/, "")
      .trim();
    name = await promptDialog(
      isFn
        ? I18n.t("函数名（保存进工具库用 · 清单靠它辨认）：")
        : I18n.t("工具名（将用作标题与 Agent 调用名）："),
      hint,
      {
        title: isFn
          ? I18n.t("保存函数到工具库")
          : I18n.t("保存工具到工具库"),
        okText: I18n.t("保存"),
      },
    );
    if (!name) return { ok: false, cancel: true };
    name = String(name).trim();
    if (!name) return { ok: false, cancel: true };
    applyFnLibName(node, name); // 标题未手动改过则一并同步
    ensureFnToolNodeState(node);
    renderCanvas();
    scheduleSave(true);
    c = node.toolConfig || {};
    name = isFn
      ? String(node.fnName || "").trim()
      : String(c.name || "").trim();
  }
  const pkg = toolPackageFromNode(node);
  if (!pkg) {
    toast(I18n.t("无法生成工具包（节点结构异常）"), "err");
    return { ok: false };
  }
  /* 同名条目已存在 → 确认覆盖（覆盖保留原 id，便于「随时可调用」开关延续） */
  try {
    const lr = await api.toolsList();
    const list = (lr && lr.ok && lr.tools) || [];
    const same = list.find((x) => String(x.name || "") === name);
    if (same && String(same.id || "") !== String(node.toolLibId || "")) {
      const sure = await confirmDialog(
        I18n.t("工具库中已有同名条目「{name}」：覆盖保存？", { name: name }),
        { title: I18n.t("覆盖工具"), okText: I18n.t("覆盖保存") },
      );
      if (!sure) return { ok: false, cancel: true };
      pkg.id = same.id;
    }
  } catch (_) {}
  const r = await api.toolsSave(pkg);
  if (!r || !r.ok) {
    toast(I18n.t("保存失败：") + ((r && r.error) || ""), "err");
    return { ok: false };
  }
  node.toolLibId = r.id; // 记住出处：再次保存 / 改名后更新同一份（两类共用该字段）
  if (!isFn) node.toolAlways = pkg.always; // 函数条目不参与 Agent 随时可调用
  renderCanvas();
  scheduleSave(true);
  return { ok: true, id: r.id, name: name || pkg.name };
}

/* 把工具包插入当前画布（克隆：新 id / 标题唯一化 / 父子归属与连线重建；可重复插入） */
async function insertToolToCanvas(pkg) {
  if (!S.wf || !Array.isArray(S.wf.nodes)) {
    toast(I18n.t("请先打开一个画布"), "warn");
    return false;
  }
  const g = (pkg && pkg.graph) || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  if (!nodes.length) {
    toast(I18n.t("工具包为空，无法插入"), "err");
    return false;
  }
  pushHistory();
  const { cps, idMap } = cloneNodesDeep(nodes, { keepOrphanParent: false });
  if (!cps.length) {
    toast(I18n.t("工具包为空，无法插入"), "err");
    return false;
  }
  const wireCps = cloneWiresForSet(Array.isArray(g.wires) ? g.wires : [], idMap);
  const innerSids = copiedSuperIdsOf(cps);
  const dx = grid() * 4;
  const dy = grid() * 4;
  for (const cp of cps) {
    /* super 内部节点使用内部坐标系：外壳偏移即可，内部坐标保持不动 */
    if (cp.parentSuperId && innerSids.has(cp.parentSuperId)) continue;
    cp.x = snap((cp.x || 0) + dx);
    cp.y = snap((cp.y || 0) + dy);
  }
  const taskFocus = currentTaskFocus();
  const superFocus = currentSuperFocus();
  let rootCp = cps[0];
  const rootId = String(g.rootId || "");
  const ri = nodes.findIndex((n) => n && String(n.id || "") === rootId);
  if (ri >= 0 && cps[ri]) rootCp = cps[ri];
  rootCp.parentTaskId = taskFocus || "";
  rootCp.parentSuperId = superFocus || "";
  rootCp.toolLibId = pkg.id || "";
  rootCp.toolAlways = !!pkg.always;
  S.wf.nodes.push(...cps);
  if (wireCps.length) S.wf.wires.push(...wireCps);
  for (const cp of cps) {
    /* 旧工具包快照可能仍是普通 kind "tool"：插入时一次性转成超级变体（与画布加载
       migrateWf 同口径 · 幂等）。内部子节点靠 parentSuperId 指向同一 id，连线两端
       也是同一批 id 与端子序号，故不需要改写连线。 */
    migrateToolNodeToSuperForm(cp);
    if (isFnToolNode(cp)) ensureFnToolNodeState(cp);
    if (cp.kind === "task" && typeof ensureTaskScaffold === "function") {
      try {
        ensureTaskScaffold(cp);
      } catch (_) {}
    }
    /* 工具壳（super 变体）默认折叠插入，避免抢占画布；需要编辑内部图时再展开。
       函数包＝单节点图，kind 是 "function" 而非 "super"，该折叠口径天然不适用。 */
    if (cp.kind === "super") cp.superOpen = false;
  }
  S.selSet = new Set(cps.map((c) => c.id));
  S.sel = rootCp.id;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    (toolEntryKind(pkg) === "function"
      ? I18n.t("已插入函数：")
      : I18n.t("已插入工具：")) +
      (pkg.name || rootCp.title || ""),
    "ok",
  );
  return true;
}

/* ── 顶栏「工具库」按钮 ─────────────────────────────────────────────
 * 顶栏入口只做一件事：打开工具库对话框（本机已保存的工具 / 函数清单 + 保存 / 插入 /
 * 改名 / 删除）。「新建工具节点 / 新建函数节点」不在这里 —— 它们和普通节点一样，
 * 从画布空白处右键菜单的「工具」一级菜单创建（app.js · canvasCreateMenuGroups）。
 * ─────────────────────────────────────────────────────────────────── */

/* ── 工具库对话框 ── */

function openToolsLibrary() {
  if (!toolsApiOk()) {
    toast(I18n.t("工具库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  openOverlay(I18n.t("工具库"));
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = document.getElementById("ovBody");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:10px;min-height:0";
  /* 顶部：从当前画布保存（工具节点 / 函数节点两类都可存进同一份工具库） */
  const saveRow = document.createElement("div");
  saveRow.style.cssText =
    "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--bd)";
  const saveLbl = document.createElement("span");
  saveLbl.textContent = I18n.t("从当前画布保存：");
  saveLbl.title = I18n.t("可保存：工具节点（带内部子图）/ 函数节点（单节点 JS 计算）");
  const sel = document.createElement("select");
  sel.id = "toolsCanvasSel";
  sel.style.cssText = "max-width:300px;flex:1;min-width:160px";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "mini primary";
  saveBtn.textContent = I18n.t("保存到工具库");
  saveBtn.title = I18n.t("把选中的工具 / 函数节点保存到工具库");
  saveRow.append(saveLbl, sel, saveBtn);
  /* 中部：库内工具清单 */
  const listHost = document.createElement("div");
  listHost.id = "toolsLibList";
  listHost.style.cssText =
    "display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:140px;max-height:54vh";
  wrap.append(saveRow, listHost);
  body.appendChild(wrap);
  const foot = document.getElementById("ovFoot");
  foot.innerHTML = "";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mini";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeOverlay;
  foot.appendChild(closeBtn);

  fillToolCanvasSel(sel);
  saveBtn.onclick = async () => {
    const nid = sel.value;
    const node = nid ? nodeById(nid) : null;
    if (!node || !isFnToolNode(node)) {
      toast(I18n.t("当前画布没有可保存的工具 / 函数节点"), "warn");
      return;
    }
    const r = await saveToolFromCanvas(node);
    if (r && r.ok) {
      toast(I18n.t("已保存到工具库：") + (r.name || ""), "ok");
      fillToolCanvasSel(sel);
      renderToolsLibList(listHost);
    }
  };
  renderToolsLibList(listHost);
}

/* 下拉框列出当前画布可保存进工具库的节点（工具节点 + 函数节点 · 带类型前缀与入出参数摘要；
   默认选中当前选中项）。函数节点＝单节点包，与工具包共用同一份存档格式。 */
function fillToolCanvasSel(sel) {
  sel.innerHTML = "";
  const nodes = ((S.wf && S.wf.nodes) || []).filter(
    (n) => isFnToolNode(n) && !isSuperIoNode(n),
  );
  if (!nodes.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = I18n.t("当前画布没有工具 / 函数节点");
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  for (const n of nodes) {
    ensureFnToolNodeState(n);
    const isFn = isFunctionNode(n);
    const c = n.toolConfig || {};
    const o = document.createElement("option");
    o.value = n.id;
    o.textContent =
      (isFn ? I18n.t("【函数】") : I18n.t("【工具】")) +
      (isFn
        ? String(n.fnName || n.title || I18n.t("（未命名函数）"))
        : String(c.name || n.title || I18n.t("（未命名工具）"))) +
      "（" +
      I18n.t("入 ") +
      fnToolParamList(n, "in").length +
      " · " +
      I18n.t("出 ") +
      fnToolParamList(n, "out").length +
      "）";
    sel.appendChild(o);
  }
  sel.disabled = false;
  if (S.sel && nodes.some((n) => n.id === S.sel)) sel.value = S.sel;
}

async function renderToolsLibList(host) {
  host.innerHTML = "";
  let tools = [];
  try {
    const r = await window.api.toolsList();
    if (r && r.ok) tools = r.tools || [];
  } catch (_) {}
  if (!tools.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "text-align:center;color:var(--muted);padding:26px 10px;font-size:12px;line-height:1.9";
    empty.textContent = I18n.t(
      "工具库为空：把画布中的工具节点 / 函数节点保存到这里（上方下拉选择），即可在任意画布插入复用。",
    );
    host.appendChild(empty);
    return;
  }
  for (const tool of tools) host.appendChild(toolsLibRow(tool, host));
}

function toolsLibRow(tool, host) {
  /* 清单区分两类条目：工具包＝橙徽「工具」，函数包＝紫徽「函数」（kind 由 toolEntryKind 判定） */
  const isFn = toolEntryKind(tool) === "function";
  const row = document.createElement("div");
  /* 全局搜索（Ctrl+F）点「工具库」结果时靠它把行滚进视野并闪一下 */
  if (tool && tool.id) row.dataset.toolId = String(tool.id);
  row.style.cssText =
    "display:flex;align-items:center;gap:10px;border:1px solid var(--bd);border-radius:6px;padding:7px 10px;background:var(--code)";
  const info = document.createElement("div");
  info.style.cssText = "flex:1;min-width:0;line-height:1.6";
  const nm = document.createElement("div");
  nm.style.cssText =
    "display:flex;align-items:center;gap:6px;font-weight:700;color:var(--orange2);font-size:13px";
  const badge = document.createElement("span");
  badge.textContent = isFn ? I18n.t("函数") : I18n.t("工具");
  badge.style.cssText =
    "flex:none;font-size:10px;font-weight:700;line-height:1;padding:3px 5px;border-radius:3px;border:1px solid " +
    (isFn ? "#c792ea" : "var(--orange2)") +
    ";color:" +
    (isFn ? "#c792ea" : "var(--orange2)");
  badge.title = isFn
    ? I18n.t("函数节点包（JS 计算 · 单节点）")
    : I18n.t("工具节点包（超级节点变体 · 带内部子图）");
  const nmTxt = document.createElement("span");
  nmTxt.textContent = tool.name || (isFn ? I18n.t("（未命名函数）") : I18n.t("（未命名工具）"));
  nmTxt.style.cssText =
    "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  nm.append(badge, nmTxt);
  nm.title = tool.name || "";
  const sub = document.createElement("div");
  sub.style.cssText = "font-size:11px;color:var(--muted)";
  const inS = I18n.listJoin((tool.inputs || []).map((p) => p.name));
  const outS = I18n.listJoin((tool.outputs || []).map((p) => p.name));
  const desc = String(tool.description || "");
  const stat =
    I18n.t("入 ") +
    (inS || "—") +
    " · " +
    I18n.t("出 ") +
    (outS || "—") +
    (isFn
      ? " · " + I18n.t("单节点（JS 计算）")
      : " · " +
        I18n.t("内部 ") +
        (tool.nodeCount || 0) +
        I18n.t(" 节点 / ") +
        (tool.wireCount || 0) +
        I18n.t(" 连线"));
  sub.textContent = desc || stat;
  sub.title = desc ? stat + (desc ? "　" + desc : "") : desc;
  info.append(nm, sub);

  /* 「会话随时可调用」开关（默认关 · 供 Agent 工具调用链路 func call）：
     只对工具条目开放 —— 该链路执行的是工具节点的内部子图，函数条目没有这条执行路，
     给它开开关等于指向一个跑不起来的可调用面。 */
  const tg = document.createElement("label");
  tg.style.cssText =
    "display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);cursor:pointer;white-space:nowrap";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!tool.always;
  const tgTxt = document.createElement("span");
  tgTxt.textContent = I18n.t("会话随时可调用");
  tg.title = I18n.t(
    "开：Agent 会话随时可调用该工具；关：仅插入画布后运行（默认关）",
  );
  if (isFn) tg.style.display = "none";
  tg.append(cb, tgTxt);
  cb.onchange = async () => {
    try {
      const r = await window.api.toolsPatch(tool.id, { always: cb.checked });
      if (r && r.ok) {
        tool.always = cb.checked;
        toast(
          cb.checked
            ? I18n.t("已开启随时可调用：") + tool.name
            : I18n.t("已关闭随时可调用：") + tool.name,
          "ok",
        );
      } else {
        cb.checked = !cb.checked;
        toast(I18n.t("保存失败：") + ((r && r.error) || ""), "err");
      }
    } catch (_) {
      cb.checked = !cb.checked;
      toast(I18n.t("保存失败"), "err");
    }
  };

  const btnInsert = document.createElement("button");
  btnInsert.type = "button";
  btnInsert.className = "mini primary";
  btnInsert.textContent = I18n.t("插入");
  btnInsert.title = I18n.t("把该工具插入当前画布（可重复插入）");
  btnInsert.onclick = async () => {
    let pkg = tool;
    try {
      const r = await window.api.toolsGet(tool.id);
      if (r && r.ok && r.tool) pkg = r.tool;
    } catch (_) {}
    await insertToolToCanvas(pkg);
  };

  const btnRename = document.createElement("button");
  btnRename.type = "button";
  btnRename.className = "mini";
  btnRename.textContent = I18n.t("改名");
  btnRename.onclick = async () => {
    const v = await promptDialog(
      isFn ? I18n.t("新函数名：") : I18n.t("新工具名："),
      tool.name,
      {
        title: isFn ? I18n.t("改名函数") : I18n.t("改名工具"),
        okText: I18n.t("确定"),
      },
    );
    if (v == null) return;
    const name = String(v).trim();
    if (!name || name === tool.name) return;
    try {
      const r = await window.api.toolsPatch(tool.id, { name: name });
      if (r && r.ok) {
        tool.name = name;
        toast(I18n.t("已改名：") + name, "ok");
        renderToolsLibList(host);
      } else {
        toast(I18n.t("改名失败：") + ((r && r.error) || ""), "err");
      }
    } catch (_) {
      toast(I18n.t("改名失败"), "err");
    }
  };

  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "mini danger";
  btnDel.textContent = I18n.t("删除");
  btnDel.onclick = async () => {
    const sure = await confirmDialog(
      I18n.t("从工具库删除「{name}」？（不影响已插入画布的副本）", {
        name: tool.name || "",
      }),
      { title: I18n.t("删除工具"), danger: true, okText: I18n.t("删除") },
    );
    if (!sure) return;
    try {
      const r = await window.api.toolsDelete(tool.id);
      if (r && r.ok) {
        toast(I18n.t("已删除工具：") + tool.name, "ok");
        renderToolsLibList(host);
      } else {
        toast(I18n.t("删除失败：") + ((r && r.error) || ""), "err");
      }
    } catch (_) {
      toast(I18n.t("删除失败"), "err");
    }
  };

  row.append(info, tg, btnInsert, btnRename, btnDel);
  return row;
}

/* ═══════════════ Agent 工具调用链路（func call） ═══════════════
 * 单一真源 tools-provider：会话每次 run 前把「当前画布的工具节点 + 工具库中
 * 开启『会话随时可调用』(always) 的工具」归成描述子列表，随 run 参数交给网关
 * （网关按工具集指纹分池并注入运行时 env → tools-plugin.mjs 注册同名函数调用
 * 工具）；模型发起调用 → 桥帧 tool-run → 本模块在宿主执行对应工具节点内部图
 * （Agent 入参经 node._agentCallArgs 注入端子，见 app.js externalValueIntoSuper）
 * → 输出写回输出端子 → 结果经 dshInteract kind:'tool' 回传；任何失败都以
 * 错误文本回执，绝不中断会话。
 * ─────────────────────────────────────────────────────────────────── */

/* 把任意字符串变成稳定的 ASCII 函数名（模型按它发起 function call） */
function agentToolAsciiName(name, key) {
  const base =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "tool";
  let h = 5381;
  const k = String(key || base);
  for (let i = 0; i < k.length; i++) h = ((h << 5) + h + k.charCodeAt(i)) >>> 0;
  return "mtnode_tool_" + base + "_" + h.toString(36).slice(0, 5);
}

function toolParamEntry(p) {
  const name = String((p && p.name) || "").trim();
  return {
    name: name,
    kind: p && p.kind === "image" ? "image" : "text",
  };
}

/* 画布工具节点 → 描述子（key = cn:<nodeId>；不携带内部图——节点已在画布上） */
function canvasToolDescriptor(node) {
  ensureFnToolNodeState(node);
  const c = node.toolConfig || {};
  const nm = String(c.name || "").trim() || String(node.title || "").trim();
  const key = "cn:" + node.id;
  return {
    key: key,
    toolName: agentToolAsciiName(nm, key),
    name: nm || I18n.t("未命名工具"),
    description: String(c.description || ""),
    inputs: fnToolParamList(node, "in").map(toolParamEntry),
    outputs: fnToolParamList(node, "out").map(toolParamEntry),
    origin: "canvas",
    nodeId: node.id,
  };
}

/* 工具库条目（always 开启） → 描述子（key = lib:<id>） */
function libToolDescriptor(t) {
  const nm = String(t && t.name || "").trim();
  const key = "lib:" + String((t && t.id) || "");
  return {
    key: key,
    toolName: agentToolAsciiName(nm, key),
    name: nm || I18n.t("未命名工具"),
    description: String((t && t.description) || ""),
    inputs: ((t && t.inputs) || []).map(toolParamEntry),
    outputs: ((t && t.outputs) || []).map(toolParamEntry),
    origin: "lib",
    libId: String((t && t.id) || ""),
  };
}

/* 单一真源快照：画布工具节点 + 库中 always 工具（同名去重，画布副本优先）。
   返回 { descs:[...], byKey:{key:desc} }；descs 供 runParams.tools（纯 JSON，
   不含内部图），byKey 供 tool-run 帧定位执行目标。 */
async function agentUserToolsSnapshot(wf) {
  const descs = [];
  const byKey = {};
  const seenName = new Set();
  const push = (d) => {
    if (!d || !d.key || byKey[d.key] || seenName.has(d.toolName)) return;
    descs.push(d);
    byKey[d.key] = d;
    seenName.add(d.toolName);
  };
  const nodes = (wf && Array.isArray(wf.nodes) && wf.nodes) || [];
  for (const n of nodes) {
    if (n && isToolNode(n) && !isSuperIoNode(n)) push(canvasToolDescriptor(n));
  }
  try {
    const r = await window.api.toolsList();
    const list = (r && r.ok && r.tools) || [];
    for (const t of list) {
      /* 函数条目不进 Agent 可调用清单：func-call 的执行链（runCanvasToolNodeForAgent）
         跑的是工具节点的内置子图，函数包没有这条执行路（清单里也不给它开关） */
      if (t && t.always && toolEntryKind(t) !== "function")
        push(libToolDescriptor(t));
    }
  } catch (_) {}
  return { descs: descs, byKey: byKey };
}

/* Agent 入参值 → 端子值对象（text → {kind:'text',text}；image → {kind:'image',path}）。
   形状转换复用端子归一的单一真源（app.js normPortValueByKind）：模型既可能给成裸路径
   字符串，也可能给成 {kind,path} 对象；声明 image 的参数一律按路径收下（loose 口径 ——
   参数类型是工具定义里写明的），不再各处各写一套 wrap。 */
function agentArgValue(raw, kind) {
  if (raw === undefined || raw === null) return null;
  return normPortValueByKind(raw, kind === "image" ? "image" : "text", {
    loose: true,
  }).value;
}

function agentValueToJson(v) {
  if (!v) return null;
  if (v.kind === "image") return { kind: "image", path: String(v.path || "") };
  if (v.kind === "audio" || v.kind === "video")
    return { kind: v.kind, path: String(v.path || ""), text: String(v.text || "") };
  return { kind: "text", text: String(v.text == null ? "" : v.text) };
}

/* 把工具执行结果整理成回传给模型的 JSON（单文本输出时同时给 text 快捷字段） */
function agentToolResultPayload(outputs, node) {
  const list = (outputs || []).map((o) => ({
    name: o && o.name ? o.name : "",
    kind: o && o.kind ? o.kind : "text",
    value: agentValueToJson(o && o.value),
  }));
  const singleText = list.length === 1 && list[0].value && list[0].value.kind === "text"
    ? list[0].value.text
    : null;
  return {
    ok: true,
    tool: (node && (node.toolConfig && node.toolConfig.name || node.title)) || "",
    outputs: list,
    ...(singleText != null ? { text: singleText.slice(0, 24000) } : {}),
  };
}

/* 运行一个画布内的工具节点（Agent 入参经 _agentCallArgs 注入端子；quiet 无弹层；
   结束后返回 {payload}，失败抛 Error 文本） */
async function runCanvasToolNodeForAgent(node, desc, args) {
  if (!node || !isToolNode(node)) throw new Error(I18n.t("工具节点不存在或已移除"));
  if (node.running)
    throw new Error(I18n.t("工具「{name}」正在运行，请稍后再调用", { name: desc.name || node.title || "" }));
  if (typeof runToolNode !== "function")
    throw new Error(I18n.t("工具节点执行引擎未就绪"));
  const inputs = desc.inputs || [];
  /* 端子对齐（契约 docs/tool-function-nodes.md §2）：输入端子 0 = 控制入（固定），
     参数 i 对应端子 i+1 → vals[i+1]；外部连线语义与 internalValueIntoSuper 的
     fromIndex 一致，Agent 入参只覆盖数据端子，控制口不动 */
  const vals = new Array(inputs.length + 1).fill(null);
  inputs.forEach((p, i) => {
    let raw;
    if (args && args[p.name] !== undefined) raw = args[p.name];
    else if (args && args["arg" + (i + 1)] !== undefined) raw = args["arg" + (i + 1)];
    else raw = null;
    vals[i + 1] = agentArgValue(raw, p.kind);
  });
  node._agentCallArgs = vals;
  try {
    await runToolNode(node, true, { noCascade: true });
  } finally {
    delete node._agentCallArgs;
  }
  if (node.error) {
    const bad = node.error;
    node.error = null;
    throw new Error(I18n.t("工具执行失败：") + bad);
  }
  const outs = node.portOutputs || {};
  const outputs = (desc.outputs || []).map((o, j) => ({
    name: o.name,
    kind: o.kind,
    value: outs["$" + j] != null ? outs["$" + j] : null,
  }));
  return agentToolResultPayload(outputs, node);
}

/* 库中 always 工具但当前画布无副本：临时物化克隆（不 pushHistory / 不落盘为永久节点），
   跑完即清理；结束前补一次 scheduleSave 修正引擎瞬态保存，确保存档不含临时副本 */
async function runLibToolShadowForAgent(desc, args, wf) {
  const api = window.api;
  const gr = await api.toolsGet(desc.libId);
  const pkg = gr && gr.ok && gr.tool ? gr.tool : null;
  const g = (pkg && pkg.graph) || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  if (!nodes.length)
    throw new Error(I18n.t("工具包不可用或已删除：") + (desc.name || ""));
  const { cps, idMap } = cloneNodesDeep(nodes, { keepOrphanParent: false });
  if (!cps.length)
    throw new Error(I18n.t("工具包不可用（无法实例化）：") + (desc.name || ""));
  const wireCps = cloneWiresForSet(Array.isArray(g.wires) ? g.wires : [], idMap);
  const ri = nodes.findIndex(
    (n) => n && String(n.id || "") === String(g.rootId || ""),
  );
  let rootCp = cps[0];
  if (ri >= 0 && cps[ri]) rootCp = cps[ri];
  for (const cp of cps) {
    /* 同 insertToolToCanvas：旧快照的 kind "tool" 根节点先转成超级变体再跑 */
    migrateToolNodeToSuperForm(cp);
    if (isFnToolNode(cp)) ensureFnToolNodeState(cp);
    cp.running = false;
  }
  /* 临时副本只活在本次调用：外壳独立到画布顶层，不挂任何父级（避免被误认为
     其它超级/任务的子节点），用完即清 */
  rootCp.parentSuperId = "";
  rootCp.parentTaskId = "";
  if (rootCp.kind === "super") rootCp.superOpen = false;
  const shadowIds = new Set(cps.map((c) => c.id));
  wf.nodes.push(...cps);
  if (wireCps.length) wf.wires.push(...wireCps);
  try {
    return await runCanvasToolNodeForAgent(rootCp, desc, args);
  } finally {
    /* 临时内部图作废 = 它名下函数节点的线程与外部进程一并作废：这批副本马上就要从
       画布上摘掉，摘掉后再没人能点 ■（连节点都查不到），残留的线程与它拉起的进程
       就成了孤儿。正常跑完时句柄早已清空（这里是空操作），异常 / 提前退出才真回收。 */
    if (typeof fnCancelRunsOfNodes === "function") {
      try {
        await fnCancelRunsOfNodes(cps);
      } catch (_) {}
    }
    wf.nodes = (wf.nodes || []).filter((n) => !shadowIds.has(n.id));
    wf.wires = (wf.wires || []).filter(
      (w) => !(shadowIds.has(w.from) || shadowIds.has(w.to)),
    );
    /* 引擎收尾会 scheduleSave(true)：这里在清理后补一次，把「临时副本」从存档里冲掉 */
    if (wf === S.wf && typeof scheduleSave === "function") {
      try { scheduleSave(true); } catch (_) {}
    }
    if (wf === S.wf && typeof renderCanvas === "function" && S.view !== "agent") {
      try { renderCanvas(); } catch (_) {}
    }
  }
}

/* 按描述子执行一次工具调用：画布节点直跑；库 always 无副本则临时物化 */
async function executeAgentToolCall(desc, args, wf) {
  const wfNodes = (wf && Array.isArray(wf.nodes) && wf.nodes) || [];
  if (desc.origin === "canvas") {
    const node = wfNodes.find((n) => n && n.id === desc.nodeId && isToolNode(n));
    if (!node)
      throw new Error(
        I18n.t("工具节点不在当前画布（可能已被删除），无法调用：") + (desc.name || ""),
      );
    return runCanvasToolNodeForAgent(node, desc, args);
  }
  /* lib：优先用画布上的同源副本，其次临时物化 */
  const copy = wfNodes.find(
    (n) => n && isToolNode(n) && String(n.toolLibId || "") === String(desc.libId || ""),
  );
  if (copy) return runCanvasToolNodeForAgent(copy, desc, args);
  return runLibToolShadowForAgent(desc, args, wf);
}

/* tool-run 帧处理：执行并回执（失败 → 错误文本，会话不中断）。
   runCtx = { toolDescs, wf }；toolDescs 为该 run 的 byKey 快照（dshRunTask 传入）。 */
async function handleToolRunEvent(data, runCtx) {
  const id = data && data.id;
  const tool = (data && data.tool) || {};
  const key = String(tool.key || "");
  const args = (data && data.args) || {};
  const answer = (result, error) =>
    window.api
      .dshInteract({
        kind: "tool",
        id: id,
        result: result == null ? undefined : result,
        error: error ? String(error) : undefined,
      })
      .catch(() => {});
  if (!id) return;
  const map = (runCtx && runCtx.toolDescs) || {};
  const desc = map[key] || null;
  if (!desc) {
    await answer(
      undefined,
      I18n.t("工具「{name}」不可用（不在本次运行的可用清单中）", {
        name: String(tool.name || key),
      }),
    );
    return;
  }
  try {
    const payload = await executeAgentToolCall(desc, args, (runCtx && runCtx.wf) || S.wf);
    await answer(payload, undefined);
  } catch (err) {
    await answer(undefined, (err && err.message) || String(err));
  }
}

/* ═══════════ 通用「试跑」台（工具 / 函数节点头部「测试」→ 独立对话框） ═══════════
 * 两类节点共用一套：中部每个输入参数一个字段（text = 多行框 / image = 路径 + 选文件），
 * 下半逐输出端子展示结果 + 错误信息。函数节点额外有上半整块 JS 代码区（node.jscode）。
 * 测试输入按节点类型落各自的独立字段（函数 fnTestInputs / 工具 toolTestInputs，
 * 按输入参数序号存，下次打开对话框还在；永不参与画布运行）。
 * 运行只读口径：
 *   · 函数节点 → app-nodes.js testFunctionNode：入参经已有的 _agentCallArgs 注入点进入，
 *     不写 node.output / portOutputs、不级联下游、不进撤销历史、不改节点运行态；
 *   · 工具节点 → 本文件 testToolNode：同一注入点 + runToolNode(quiet, noCascade)，
 *     跑完把工具壳自身的运行态原样还原 —— 壳的输出与下游不受影响（内部子节点会真实
 *     执行，其输出会更新，可能产生真实 API 调用，对话框已注明）。
 * 画布上的 ▶ 才是参与运行的真执行。
 * ─────────────────────────────────────────────────────────────────── */

/* 测试字段里的字符串 → 端子值（空串 = 未提供，注入 null 与「上游未输出」一致）。
   形状转换同样复用端子归一真源（见 agentArgValue）：图像参数 → {kind:"image",path}，
   文本参数 → {kind:"text",text}。 */
function fnTestPortValue(raw, kind) {
  const s = raw == null ? "" : String(raw);
  if (!s.trim()) return null;
  return normPortValueByKind(s, kind === "image" ? "image" : "text", {
    loose: true,
  }).value;
}

/* 数组（批量）参数：判定真源 app-canvas.js · fnBrowseParamIsArray（array / arr / list /
   batch / repeat 任一为真，或 kind 含 array|list）—— 与连线放行、端子取数同一口径；
   桩环境缺该函数时退回参数上的 list 位。 */
function fnTestParamIsArray(p) {
  if (!p) return false;
  return typeof fnBrowseParamIsArray === "function"
    ? !!fnBrowseParamIsArray(p)
    : p.list === true;
}

/* 数组参数的测试快照 → 行数组（一行一条值）。存档里的正常形状是字符串数组；
   兼容旧存档该位仍是字符串（数组语义落地前存的单值）：按行拆开，
   图像路径通常就一行 → 拆完即一条。 */
function fnTestRowsOfStore(raw) {
  if (Array.isArray(raw)) return raw.map((v) => (v == null ? "" : String(v)));
  const s = raw == null ? "" : String(raw);
  if (!s) return [];
  return s.split(/\r?\n/);
}

/* 普通（非数组）参数位上的单值读取：取消数组勾选后该位可能还留着字符串数组
   → 文本按换行并回一格（不丢内容），图像取第一条路径（一格只看一张）。 */
function fnTestSingleOfStore(raw, kind) {
  if (Array.isArray(raw)) {
    const arr = raw
      .map((v) => (v == null ? "" : String(v)))
      .filter((v) => v.trim() !== "");
    if (!arr.length) return "";
    return kind === "image" ? arr[0] : arr.join("\n");
  }
  return raw == null ? "" : String(raw);
}

/* 测试字段 → 注入值：数组参数逐条归一后以数组注入（空行不注入，全空 = 空数组 ——
   引擎那边「数组端子恒为数组」，函数体可无条件 .map / .length）；
   普通参数维持单值旧口径（空 = null）。 */
function fnTestPortValueOfParam(p, raw) {
  const kind = p && p.kind === "image" ? "image" : "text";
  if (!fnTestParamIsArray(p))
    return fnTestPortValue(fnTestSingleOfStore(raw, kind), kind);
  return fnTestRowsOfStore(raw)
    .map((v) => fnTestPortValue(v, kind))
    .filter((v) => v != null);
}

/* 端子值 → 展示用一行文本 */
function fnTestValueText(v) {
  if (v == null) return "—";
  if (typeof v !== "object") return String(v);
  const s =
    v.text != null && String(v.text) !== ""
      ? String(v.text)
      : v.path != null
        ? String(v.path)
        : "";
  return s === "" ? "（空）" : s;
}

/* 「试跑」一个工具节点（只读口径见本段头注释）：入参按端子序号经 node._agentCallArgs
   注入（与 Agent func call 同一注入点），走 runToolNode(node, quiet=true, {noCascade:true})
   跑内部图；取完结果后把工具壳自身的运行态字段原样还原（含此前不存在的字段 → 删除），
   所以测试不改画布输出、不级联下游、不进撤销历史。
   返回与 testFunctionNode 同形状的 { ok, ports, count, error }。 */
async function testToolNode(node, vals) {
  const fail = (msg) => ({
    ok: false,
    ports: { __error: msg },
    count: 0,
    error: msg,
  });
  if (!node || !isToolNode(node)) return fail(I18n.t("工具节点不存在或已移除"));
  if (node.running) return fail(I18n.t("工具正在运行，请稍后再试"));
  if (typeof runToolNode !== "function")
    return fail(I18n.t("工具节点执行引擎未就绪"));
  /* 壳自身运行态快照：跑完逐项还原（undefined ≠ 缺失，故按 hasOwnProperty 判定） */
  const STATE_FIELDS = [
    "running",
    "error",
    "output",
    "batchOutputs",
    "attemptOutputs",
    "attemptsDone",
    "portOutputs",
    "ranAt",
    "_abKey",
    "_aborted",
    /* 端子归一提示（引擎在写回输出时记的 transient 文案）：测试同样要还原，
       否则试跑会把「图像降级为文本」的提示留在节点摘要上 */
    "_portKindFix",
  ];
  const snap = {};
  for (const k of STATE_FIELDS)
    if (Object.prototype.hasOwnProperty.call(node, k)) snap[k] = node[k];
  const prevArgs = node._agentCallArgs;
  node._agentCallArgs = Array.isArray(vals) ? vals : [];
  let res = null;
  try {
    await runToolNode(node, true, { noCascade: true });
    const ports = Object.assign({}, node.portOutputs || {});
    const err = String(node.error || ports.__error || "");
    const count = Object.keys(ports).filter(
      (k) => k.charAt(0) === "$" && ports[k] != null,
    ).length;
    res = { ok: !err, ports, count, error: err };
  } catch (e) {
    res = fail((e && e.message) || String(e));
  } finally {
    for (const k of STATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(snap, k)) node[k] = snap[k];
      else delete node[k];
    }
    if (prevArgs === undefined) delete node._agentCallArgs;
    else node._agentCallArgs = prevArgs;
    /* 引擎收尾已把「测试中的输出」写进存档，这里补一次落盘把还原后的状态盖回去 */
    if (typeof scheduleSave === "function") {
      try {
        scheduleSave();
      } catch (_) {}
    }
    /* 还原后重绘：节点卡片回到测试前的外观（引擎收尾自己 render 过，这里补一次） */
    if (typeof refreshNodeUi === "function") {
      try {
        refreshNodeUi(node);
      } catch (_) {}
    }
  }
  return res;
}

function openNodeTestDialog(node) {
  if (!node || !isFnToolNode(node)) {
    toast(I18n.t("「测试」仅用于工具 / 函数节点"), "warn");
    return;
  }
  ensureFnToolNodeState(node);
  const isTool = isToolNode(node);
  /* 测试输入按类型各存一份独立字段：函数 fnTestInputs / 工具 toolTestInputs */
  const storeKey = isTool ? "toolTestInputs" : "fnTestInputs";
  if (!Array.isArray(node[storeKey])) node[storeKey] = [];
  const testVals = node[storeKey];
  const ins = fnToolParamList(node, "in");
  const outs = fnToolParamList(node, "out");
  openOverlay(
    (isTool
      ? I18n.t("工具节点试跑 · ")
      : I18n.t("函数节点测试 · ")) + (node.title || (isTool ? I18n.t("工具") : I18n.t("函数"))),
  );
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = document.getElementById("ovBody");
  body.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:10px;min-height:0";
  const section = (t) => {
    const h = document.createElement("div");
    h.className = "settings-sec-title";
    h.textContent = t;
    wrap.appendChild(h);
  };
  const hint = (t, color) => {
    const d = document.createElement("div");
    d.className = "settings-hint";
    d.style.lineHeight = "1.5";
    if (color) {
      d.style.color = color;
      d.style.opacity = "1";
    }
    d.textContent = t;
    wrap.appendChild(d);
    return d;
  };

  hint(
    isTool
      ? I18n.t(
          "仅测试用，不参与画布运行：测试入参只注入本次执行，工具自身的输出与下游节点保持不变（不进撤销历史）。",
        )
      : I18n.t(
          "仅测试用，不参与画布运行：测试入参只注入本次执行，不写节点输出、不级联下游、不进撤销历史。",
        ),
  );

  /* ── JS 代码区（仅函数节点 · 大块 · 与节点卡片同一个 createJsCodeEditor · 同源 node.jscode） ── */
  let codeEd = null;
  if (!isTool) {
    section(I18n.t("JS 代码（return 的键 = 输出参数名 → 分发到各输出端子）"));
    codeEd = createJsCodeEditor({
      value: functionCodeOf(node),
      rows: 18,
      placeholder: I18n.t("// 在此编写函数体：input = { 参数名: 值 }，return { 输出参数名: 值 }"),
      /* 输入只写内存字段，失焦 / change / 格式化才落盘（与节点卡片同口径） */
      onChange: (v) => {
        node.jscode = v;
      },
      onCommit: (v) => {
        node.jscode = v;
        scheduleSave();
      },
    });
    codeEd.el.style.cssText = "width:100%;flex:none;min-height:240px";
    wrap.appendChild(codeEd.el);
    /* 工具条：就地格式化（复用编辑器自带的 format = formatJsCode 同一实现） */
    const codeBar = document.createElement("div");
    codeBar.style.cssText = "display:flex;gap:8px;align-items:center";
    const fmtBtn = document.createElement("button");
    fmtBtn.type = "button";
    fmtBtn.className = "mini";
    fmtBtn.textContent = I18n.t("格式化");
    fmtBtn.onclick = () => {
      if (!codeEd.format()) toast(I18n.t("代码已是格式化后的样子"));
    };
    const codeHint = document.createElement("span");
    codeHint.style.cssText = "font-size:11.5px;opacity:.7";
    codeHint.textContent = I18n.t(
      "与节点卡片同一编辑器 · 改动即时写回 node.jscode",
    );
    codeBar.append(fmtBtn, codeHint);
    wrap.appendChild(codeBar);
  } else {
    /* 工具节点没有代码区：试跑跑的是它的内部子图，先说清里面有什么 */
    const inner =
      typeof superChildrenOf === "function" ? superChildrenOf(node.id) : [];
    hint(
      inner.length
        ? I18n.t(
            "试跑会真实执行内部子图（{n} 个内部节点 · 可能产生真实 API 调用），只把结果读回这里，不改工具自身输出。",
            { n: inner.length },
          )
        : I18n.t(
            "该工具内部还没有节点：先展开 / 进入子画布将参数接成处理图，再回来试跑。",
          ),
    );
  }

  /* ── 输入字段：每个输入参数一个 ── */
  section(I18n.t("输入参数（端子 1..n · 端子 0 = 控制入）"));
  if (!ins.length)
    hint(I18n.t("（无输入参数 · 在「设置」里添加）"));
  ins.forEach((p, i) => {
    const isImg = p.kind === "image";
    const isArr = fnTestParamIsArray(p);
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:11.5px;opacity:.8";
    lab.textContent =
      I18n.t("端子 ") +
      (i + 1) +
      " · " +
      (p.name || I18n.t("参数 ") + (i + 1)) +
      (isImg ? I18n.t("（图像）") : I18n.t("（文本）")) +
      (isArr ? I18n.t(" · 数组端子（JS 里拿到数组 · 一行一条）") : "");
    wrap.appendChild(lab);
    const store = (v) => {
      testVals[i] = v;
    };
    /* ── 数组参数：可 ＋/－ 的多行输入，一行一条值，值以数组注入 ──
       （旧存档该位可能还是字符串 → fnTestRowsOfStore 按行拆，不丢原值） */
    if (isArr) {
      const host = document.createElement("div");
      host.style.cssText = "display:flex;flex-direction:column;gap:4px";
      const cnt = document.createElement("span");
      cnt.style.cssText = "font-size:11px;opacity:.62";
      /* 回写快照：只收非空行（全空 = 空数组，等价于不注入）并回显条数 */
      const sync = () => {
        const arr = [];
        host.querySelectorAll("input[data-fnrow]").forEach((el) => {
          const v = String(el.value == null ? "" : el.value);
          if (v.trim()) arr.push(v);
        });
        store(arr);
        cnt.textContent =
          I18n.t("当前注入 ") +
          arr.length +
          I18n.t(" 条（数组端子 · JS 里拿到数组）");
      };
      const mkRow = (val) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px;align-items:center";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.setAttribute("data-fnrow", "1");
        inp.style.cssText = "flex:1;min-width:0";
        inp.placeholder = isImg
          ? I18n.t("图像文件路径（一行一条 · 留空的行不注入）")
          : I18n.t("数组元素（一行一条 · 留空的行不注入）");
        inp.value = String(val == null ? "" : val);
        const thumb = document.createElement("img");
        thumb.style.cssText =
          "display:none;width:40px;height:40px;object-fit:cover;border-radius:6px;flex:none;border:1px solid var(--bd)";
        const paintThumb = () => {
          const path = String(inp.value || "").trim();
          if (!path) {
            thumb.style.display = "none";
            thumb.removeAttribute("src");
            return;
          }
          thumb.src = window.api.toFileUrl(path);
          thumb.style.display = "block";
        };
        inp.addEventListener("input", sync);
        inp.addEventListener("change", () => {
          sync();
          scheduleSave();
          if (isImg) paintThumb();
        });
        row.appendChild(inp);
        if (isImg) {
          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "mini";
          pick.textContent = I18n.t("选择文件");
          pick.onclick = async () => {
            const r = await window.api.fileOpenDialog({
              title: I18n.t("选择图像"),
              filters: [
                {
                  name: I18n.t("图像"),
                  extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                },
              ],
            });
            if (!r || !r.path) return;
            inp.value = r.path;
            sync();
            scheduleSave();
            paintThumb();
          };
          row.append(pick, thumb);
          paintThumb();
        }
        const del = document.createElement("button");
        del.type = "button";
        del.className = "mini";
        del.textContent = "－";
        del.title = I18n.t("删除这一条（数组元素的行）");
        del.onclick = () => {
          row.remove();
          if (!host.childElementCount) host.appendChild(mkRow(""));
          sync();
          scheduleSave();
        };
        row.appendChild(del);
        return row;
      };
      const init = fnTestRowsOfStore(testVals[i]);
      (init.length ? init : [""]).forEach((v) => host.appendChild(mkRow(v)));
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:8px;align-items:center";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "mini";
      add.textContent = "＋ " + I18n.t("添加一条");
      add.onclick = () => {
        const row = mkRow("");
        host.appendChild(row);
        sync();
        scheduleSave();
        const el = row.querySelector("input");
        if (el) el.focus();
      };
      bar.append(add, cnt);
      wrap.append(host, bar);
      sync();
      return;
    }
    if (isImg) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;align-items:center";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.style.cssText = "flex:1;min-width:0";
      inp.placeholder = I18n.t("图像文件路径（留空 = 不注入该参数）");
      inp.value = fnTestSingleOfStore(testVals[i], "image");
      inp.addEventListener("input", () => store(inp.value));
      inp.addEventListener("change", () => {
        store(inp.value);
        scheduleSave();
        paintThumb();
      });
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "mini";
      pick.textContent = I18n.t("选择文件");
      pick.onclick = async () => {
        const r = await window.api.fileOpenDialog({
          title: I18n.t("选择图像"),
          filters: [
            {
              name: I18n.t("图像"),
              extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            },
          ],
        });
        if (!r || !r.path) return;
        inp.value = r.path;
        store(r.path);
        scheduleSave();
        paintThumb();
      };
      const thumb = document.createElement("img");
      thumb.style.cssText =
        "display:none;width:40px;height:40px;object-fit:cover;border-radius:6px;flex:none;border:1px solid var(--bd)";
      const paintThumb = () => {
        const path = String(inp.value || "").trim();
        if (!path) {
          thumb.style.display = "none";
          thumb.removeAttribute("src");
          return;
        }
        thumb.src = window.api.toFileUrl(path);
        thumb.style.display = "block";
      };
      row.append(inp, pick, thumb);
      wrap.appendChild(row);
      paintThumb();
    } else {
      const ta = document.createElement("textarea");
      ta.rows = 3;
      ta.style.cssText =
        "width:100%;flex:none;resize:vertical;font-size:12px;font-family:var(--mono)";
      ta.placeholder = I18n.t("测试文本（留空 = 不注入该参数）");
      ta.value = fnTestSingleOfStore(testVals[i], "text");
      ta.addEventListener("input", () => store(ta.value));
      ta.addEventListener("change", () => {
        store(ta.value);
        scheduleSave();
      });
      wrap.appendChild(ta);
    }
  });

  /* ── 输出：逐端子展示 + 错误 ── */
  section(I18n.t("输出端子"));
  const outHost = document.createElement("div");
  outHost.style.cssText =
    "display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:60px;max-height:38vh";
  const outEmpty = document.createElement("div");
  outEmpty.style.cssText = "font-size:11.5px;opacity:.6";
  outEmpty.textContent = I18n.t("（尚未运行测试）");
  outHost.appendChild(outEmpty);
  wrap.appendChild(outHost);

  const paintResult = (res) => {
    outHost.innerHTML = "";
    const ports = (res && res.ports) || {};
    const errText = (res && res.error) || "";
    if (errText) {
      const e = document.createElement("div");
      e.style.cssText =
        "font-size:12px;color:var(--red);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all";
      e.textContent = I18n.t("错误：") + errText;
      outHost.appendChild(e);
    }
    const rows = [];
    for (let j = 0; j < outs.length; j++)
      rows.push({
        idx: j,
        name: outs[j].name || I18n.t("参数 ") + (j + 1),
        value: ports["$" + j],
        written: Object.prototype.hasOwnProperty.call(ports, "$" + j),
      });
    /* 函数节点即使没设出参也有「单输出兼容」的端子 0；工具节点没有出参就是真没有 */
    if (!outs.length && !isTool)
      rows.push({ idx: 0, name: I18n.t("主输出（无出参）"), value: ports.$0, written: !!ports.$0 });
    if (!rows.length) {
      const n2 = document.createElement("div");
      n2.style.cssText = "font-size:11.5px;opacity:.6";
      n2.textContent = I18n.t("（无输出参数 · 在「设置」里添加）");
      outHost.appendChild(n2);
    }
    for (const r of rows) {
      const row = document.createElement("div");
      row.style.cssText =
        "border:1px solid var(--bd);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:3px";
      const h = document.createElement("div");
      h.style.cssText = "font-size:11.5px;opacity:.8";
      h.textContent =
        I18n.t("端子 ") +
        r.idx +
        " · " +
        r.name +
        (r.written
          ? ""
          : isTool
            ? I18n.t("（内侧无节点汇入该输出端子）")
            : I18n.t("（return 未含该键 · 未分发）"));
      const v = document.createElement("div");
      v.style.cssText =
        "font-size:12px;font-family:var(--mono);white-space:pre-wrap;word-break:break-all;max-height:140px;overflow-y:auto";
      v.textContent = fnTestValueText(r.value);
      if (r.value && r.value.kind && r.value.kind !== "text" && r.value.path) {
        const img = document.createElement("img");
        img.style.cssText = "max-width:180px;max-height:120px;border-radius:6px";
        img.src = window.api.toFileUrl(String(r.value.path));
        v.appendChild(document.createElement("br"));
        v.appendChild(img);
      }
      row.append(h, v);
      outHost.appendChild(row);
    }
  };

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "mini primary";
  runBtn.textContent = I18n.t(isTool ? "▶ 试跑工具" : "▶ 运行测试");
  const opsRow = document.createElement("div");
  opsRow.style.cssText = "display:flex;gap:8px;align-items:center";
  const opsNote = document.createElement("span");
  opsNote.style.cssText = "font-size:11.5px;opacity:.7";
  opsNote.textContent = I18n.t(
    isTool
      ? "测试不改画布：工具自身的输出与下游取值仍是上次画布 ▶ 的结果。"
      : "测试不改画布：节点输出与下游取值仍是上次画布 ▶ 的结果。",
  );
  opsRow.append(runBtn, opsNote);
  wrap.appendChild(opsRow);
  body.appendChild(wrap);

  let testing = false;
  runBtn.onclick = async () => {
    if (testing) return;
    if (codeEd) node.jscode = codeEd.getValue();
    const vals = new Array(ins.length + 1).fill(null);
    ins.forEach((p, i) => {
      /* 数组参数 → 逐条归一后以数组注入；普通参数仍是单值（空 = null） */
      vals[i + 1] = fnTestPortValueOfParam(p, testVals[i]);
    });
    testing = true;
    const label = runBtn.textContent;
    runBtn.disabled = true;
    /* 两类节点都不在渲染进程里同步跑了：函数跑在主进程的独立线程，工具要跑整张
       内部图 —— 两者都是 await 才有结果，期间按钮一律显示忙碌态 */
    runBtn.textContent = I18n.t("试跑中…");
    let res;
    try {
      res = isTool
        ? typeof testToolNode === "function"
          ? await testToolNode(node, vals)
          : {
              ok: false,
              ports: {},
              error: I18n.t("工具试跑执行器未就绪（app-tools.js）"),
            }
        : typeof testFunctionNode === "function"
          ? await testFunctionNode(node, vals)
          : { ok: false, ports: {}, error: I18n.t("测试执行器未就绪（app-nodes.js）") };
    } finally {
      testing = false;
      runBtn.disabled = false;
      runBtn.textContent = label;
    }
    /* 只读执行：本对话框不改节点运行态；这里只把测试输入快照落盘 */
    scheduleSave();
    paintResult(res);
    toast(
      res.ok
        ? I18n.t("测试完成")
        : I18n.t("测试失败：") + (res.error || ""),
      res.ok ? "ok" : "err",
    );
  };

  const foot = document.getElementById("ovFoot");
  foot.innerHTML = "";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mini";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = () => {
    /* JS 与测试输入都已实时写回 node（不进撤销历史）；这里只落盘 + 重绘节点体 */
    if (codeEd) node.jscode = codeEd.getValue();
    scheduleSave();
    renderCanvas();
    closeOverlay();
  };
  foot.appendChild(closeBtn);
}

/* ══════════════════ 函数节点「开发」= 绑定该函数的会话 ══════════════════
 * 与开发节点的「开发」同一套机制（弹窗填需求 → 新建绑定会话 → 契约注入系统提示 →
 * 后台运行、留在画布），差别只有两点：
 *   1) 作用域钉死在**这一个函数节点**上：会话只能经 mtnode_canvas_edit 的 update
 *      补丁本节点的 jscode / inputs / outputs / description，不碰其它节点与连线；
 *   2) 会话 id 记在 node.fnDevSessionIds，与开发节点的 devSessionIds 各走各的
 *      （函数节点不是 super+dev，混用会让功能块「最近一次要求」/队列判定串台）。
 * ─────────────────────────────────────────────────────────────────── */

/* 函数名（徽标与展示真源）：没填 fnName 时退回节点标题 */
function fnDevNameOf(node) {
  if (!node) return "";
  return String(node.fnName || "").trim() || String(node.title || "").trim();
}

/* 参数表一行：端子序号 + 参数名 + 声明类型（text|image），列表入参端子再标一个 ×N。
   入参端子从 1 起（端子 0 = 控制入），出参端子从 0 起（末位 = 控制出）。 */
function fnDevParamLine(list, startIdx, isIn) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return I18n.t("（无）");
  const dirIn = isIn === true;
  return arr
    .map((p, i) => {
      const nm = String((p && p.name) || "").trim() || I18n.t("参数 ") + (startIdx + i);
      return (
        startIdx +
        i +
        ":" +
        nm +
        "(" +
        (p && p.kind === "image" ? "image" : "text") +
        /* 列表（数组）入参端子标 ×N：该端子吃的是一组值，jscode 里取到的是数组 */
        (dirIn && p && p.list === true ? ",×N" : "") +
        ")"
      );
    })
    .join("、");
}

/* 该函数节点名下的开发会话（按最近活动排序） */
function fnDevSessionsOf(node) {
  const ids = Array.isArray(node && node.fnDevSessionIds)
    ? node.fnDevSessionIds
    : [];
  if (!ids.length) return [];
  return agentSessions()
    .filter((s) => s && ids.indexOf(s.id) >= 0)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

/* 对话框里回显「最近一次要求」，方便用户接着迭代（与开发节点同一取法） */
function fnDevLastRequestOf(node) {
  const sess = fnDevSessionsOf(node)[0];
  if (!sess) return "";
  const msgs = sess.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user" || m._src) continue;
    const t = String(m.content || "").trim();
    if (t) return t.length > 160 ? t.slice(0, 160) + "…" : t;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (typeof devReqTextOfMessage !== "function") break;
    const req = devReqTextOfMessage(msgs[i]);
    if (req) return req.length > 160 ? req.slice(0, 160) + "…" : req;
  }
  return "";
}

/* 函数开发任务书 = 该会话的契约（写进 session._devContract，每轮随系统提示注入）：
   前半是现状（描述 / 参数即端子 / 代码行数），后半是钉死的边界。 */
function fnDevContractText(node, req) {
  ensureFnToolNodeState(node);
  const name = fnDevNameOf(node) || I18n.t("未命名函数");
  const ins = fnToolParamList(node, "in");
  const outs = fnToolParamList(node, "out");
  const code = String(functionCodeOf(node) || "");
  const codeLines = code ? code.split("\n").length : 0;
  const lines = [];
  lines.push(
    I18n.t("【函数开发任务书】") +
      " " +
      name +
      "（" +
      I18n.t("函数节点") +
      (String(node.title || "").trim() && node.title !== name
        ? I18n.t(" · 标题：") + node.title
        : "") +
      "）",
  );
  lines.push(
    I18n.t("节点描述：") +
      (String(node.description || "").trim() || I18n.t("（无）")),
  );
  lines.push(
    I18n.t("入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：") +
      fnDevParamLine(ins, 1, true),
  );
  lines.push(
    I18n.t("出参端子（0..M-1 = 各出参，末位 = 控制出）：") +
      fnDevParamLine(outs, 0),
  );
  lines.push(
    I18n.t("JS 代码：共 ") +
      codeLines +
      I18n.t(" 行（真实内容以 mtnode_canvas_get 读到的为准）"),
  );
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  if (reqText) lines.push(I18n.t("本次开发需求：") + reqText);
  lines.push(
    I18n.t(
      "本会话由该函数节点的「开发」按钮新建，只负责这一个函数；请以画布上该节点的真实配置为准，不要臆测，也不要顺手扩展无关功能。",
    ),
  );
  lines.push(
    I18n.t(
      "改动边界（必须严格遵守）：① 先用 mtnode_canvas_get 读该节点现状（detail:\"full\"、ids:[本节点标题]），再只用 mtnode_canvas_edit 的 update 补丁本节点的 jscode / inputs / outputs / description（必要时 setTitle 同步函数名）；② 不得新建、删除或改动画布上的任何其它节点，也不得增删连线；③「参数即端子」——改 inputs / outputs 参数表就是改端子，端子数一变已连的线就可能改指别的端子，因此只要动了参数表，就必须在回复里明确提醒用户回画布复核该节点的连线。",
    ),
  );
  lines.push(
    I18n.t("本节点标题（mtnode_canvas_get 的 ids 与 update 的定位就用它）：") +
      (String(node.title || "").trim() || name) +
      " · id=" +
      node.id,
  );
  lines.push(
    I18n.t(
      "执行契约：jscode 里 input = { 参数名: 值 }（文本参数值为字符串 · 图像参数值为 { kind:\"image\", path } · 标 ×N 的列表端子值恒为数组，即使只连了一条线也是数组，用 for / map 逐项处理，别当单值用），return { 输出参数名: 值 } 按参数名分发到各输出端子（输出端子一律单值，要返回多个值请返回数组给下游标 ×N 的列表入参端子）；保持 2 空格缩进的整洁排版（画布上的代码编辑器带高亮与格式化）。",
    ),
  );
  lines.push(
    I18n.t(
      "运行环境：代码在 MTNode 主进程的独立线程里执行（可 await、可跑循环，不会卡界面），**没有 window / document / window.api.***；起外部程序用 mtnode.exec / mtnode.spawn（隐藏启动、随本次运行回收，停止即杀进程树），读写文件用 mtnode.readText / mtnode.writeText，等待用 await mtnode.sleep(ms)，日志与进度用 mtnode.log / mtnode.progress。不要写依赖渲染层 API 的代码。",
    ),
  );
  lines.push(
    I18n.t(
      "需求不明确时先问用户再动手；改完用一句话汇报改了什么（是否动了参数表）。",
    ),
  );
  lines.push(
    I18n.t(
      "本次开发需求已在任务书中一次性完整给出：请按此执行，不要分两次会话输入重复提交（重复输入会造成上下文割裂与重复开工）。",
    ),
  );
  return lines.join("\n");
}

/* 每次「开发」都新建会话运行：上下文干净，工作区 = 节点所属画布目录，
   provider / model / effort 跟随用户当前默认（不硬编模型）。 */
function createFnDevSessionForNode(node, req) {
  if (!node || !isFunctionNode(node)) return null;
  /* 跟随「当前默认」：读用户现在这条活动会话的预设 / 路由 / 模型 / 思考强度，
     没有活动会话就回落到引擎默认 —— 绝不在这里硬编模型。
     （用 agentSessionById 而非 agentSessionState：后者会在无会话时顺手建一条空会话） */
  const cur =
    typeof agentSessionById === "function"
      ? agentSessionById(S.agentActiveId)
      : null;
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  const sess = {
    id: uid("as"),
    title:
      I18n.t("开发 · ") + (fnDevNameOf(node) || I18n.t("未命名函数")),
    workspace: dshWorkspaceOf(node) || "",
    /* 函数开发会话：所属画布 = 该函数节点所在画布 */
    canvasWfId: canvasWfIdForNode(node),
    preset: (cur && cur.preset) || AGENT_PRESET_DEFAULT,
    provider: (cur && cur.provider) || "deepseek-official",
    model: (cur && cur.model) || "",
    effort: (cur && cur.effort) || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  /* 任务书整份写进会话契约（发送时注入系统提示，见 agentSessionSend 的 _devContract
     分支）：不占用户消息位，会话里只显示用户填写的关键输入 */
  sess._devContract = fnDevContractText(node, reqText);
  sess.messages.unshift({
    role: "user",
    content: reqText
      ? I18n.t("本次开发需求：") + reqText
      : sess._devContract,
    _src: "dev-node",
    _nid: node.id,
  });
  agentSessions().unshift(sess);
  if (!Array.isArray(node.fnDevSessionIds)) node.fnDevSessionIds = [];
  node.fnDevSessionIds.unshift(sess.id);
  while (node.fnDevSessionIds.length > 24) node.fnDevSessionIds.pop();
  return sess;
}

/* 「开发」（函数节点 body 下方按钮）：弹窗展示现状 + 填写本次要改 / 扩展的内容
   → 确认后新建绑定该函数的会话并在其中运行（留在画布，不跳会话视图）。 */
async function developFunctionNode(node) {
  if (!node || !isFunctionNode(node)) return;
  ensureFnToolNodeState(node);
  const name = fnDevNameOf(node) || I18n.t("未命名函数");
  const ws = dshWorkspaceOf(node) || "";
  const code = String(functionCodeOf(node) || "");
  const rows = [
    [I18n.t("函数名"), name],
    [I18n.t("节点标题"), node.title || I18n.t("（未命名）")],
    [
      I18n.t("描述"),
      String(node.description || "").trim() || I18n.t("（无）"),
    ],
    [
      I18n.t("入参端子"),
      fnDevParamLine(fnToolParamList(node, "in"), 1) +
        "（" +
        I18n.t("端子 0 = 控制入") +
        "）",
    ],
    [
      I18n.t("出参端子"),
      fnDevParamLine(fnToolParamList(node, "out"), 0) +
        "（" +
        I18n.t("末位 = 控制出") +
        "）",
    ],
    [
      I18n.t("JS 代码"),
      I18n.t("共 ") + (code ? code.split("\n").length : 0) + I18n.t(" 行"),
    ],
    [I18n.t("会话工作区"), ws || I18n.t("（应用默认数据目录）")],
  ];
  const last = fnDevLastRequestOf(node);
  if (last) rows.push([I18n.t("最近一次要求"), last]);
  const res = await mtDialogForm({
    title: I18n.t("开发") + " · " + name,
    wide: true,
    rows,
    msg: I18n.t(
      "请说明本次要修改或扩展这个函数的哪些行为；确认后将新建一个绑定该函数的会话并在其中运行。",
    ),
    warn: code
      ? ""
      : I18n.t("该函数还没有 JS 代码：会话会按现有入出参从零写出函数体。"),
    textarea: devDraftTextareaOpts(node, "fnDev", {
      label: I18n.t("本次希望修改 / 扩展的内容"),
      placeholder: I18n.t(
        "例如：入参 text 去掉首尾空白再按标点分句；新增一个 image 入参并把路径原样透传到出参；出错时不要抛异常，改为 return { error }…",
      ),
      rows: 6,
      requiredMsg: I18n.t("请填写本次希望修改或扩展的内容"),
    }),
    /* 边写边留存：取消 / Esc / 被别的弹窗顶掉都不丢，下次打开原样回填 */
    onText: (t) => devDraftSet(node, "fnDev", t),
    hint: I18n.t(
      "确认 = 新会话后台运行（工作区 = 画布目录 · 标题「开发 · 函数名」· 只改这一个函数节点 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消",
    ),
    requireText: true,
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "go", label: I18n.t("开始开发"), primary: true },
    ],
  });
  if (!res || res.action !== "go") return;
  /* 已提交进会话：草稿使命完成，清掉，避免下次打开重复带上同一份内容 */
  devDraftSet(node, "fnDev", "");
  const body = String(res.text || "").trim();
  if (!body) return;
  const sess = createFnDevSessionForNode(node, body);
  if (!sess) return;
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  renderCanvas();
  /* 运行队列按「绑定会话」口径立刻重算一次 */
  if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
  toast(
    I18n.t("已创建函数开发会话「") +
      (sess.title || "") +
      I18n.t("」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）"),
    "ok",
  );
  try {
    /* 任务书整份在会话契约里，首条消息只有用户关键输入：发这一条空消息即可启动本轮 */
    await agentSessionSend("", { _devContract: true });
  } catch (err) {
    toast(
      I18n.t("开发会话启动失败：") + ((err && err.message) || String(err)),
      "err",
    );
  }
}

/* ══════════════════ 工具节点「开发」= 绑定该工具的会话 ══════════════════
 * 与函数节点「开发」同一套机制（弹窗填需求 → 新建绑定会话 → 契约注入系统提示 →
 * 后台运行、留在画布），差别：
 *   1) 作用域 = 这一个工具节点 + 它的内部子图：会话可经 mtnode_canvas_edit
 *      update 本工具 toolConfig（name / description / inputs / outputs），并可在
 *      本工具内部新建 / 删除 / 改动节点与连线来调整工具行为（工具行为 = 内部子图，
 *      不是一段 JS）；不得触碰画布上其它任何节点 / 连线；
 *   2) 会话 id 记在 node.toolDevSessionIds，与函数节点的 fnDevSessionIds、
 *      开发节点的 devSessionIds 各走各的（工具节点虽是 super 变体但不是 dev:true，
 *      混用会让功能块「最近一次要求」/队列判定串台）。
 * ─────────────────────────────────────────────────────────────────── */

/* 工具名（徽标与展示真源）：toolConfig.name 优先，空则退回节点标题 */
function toolDevNameOf(node) {
  if (!node) return "";
  const c =
    isToolNode(node) && node.toolConfig && typeof node.toolConfig === "object"
      ? node.toolConfig
      : {};
  return String(c.name || "").trim() || String(node.title || "").trim();
}

/* 该工具节点名下的开发会话（按最近活动排序） */
function toolDevSessionsOf(node) {
  const ids = Array.isArray(node && node.toolDevSessionIds)
    ? node.toolDevSessionIds
    : [];
  if (!ids.length) return [];
  return agentSessions()
    .filter((s) => s && ids.indexOf(s.id) >= 0)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

/* 对话框里回显「最近一次要求」（与函数版同一取法） */
function toolDevLastRequestOf(node) {
  const sess = toolDevSessionsOf(node)[0];
  if (!sess) return "";
  const msgs = sess.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user" || m._src) continue;
    const t = String(m.content || "").trim();
    if (t) return t.length > 160 ? t.slice(0, 160) + "…" : t;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (typeof devReqTextOfMessage !== "function") break;
    const req = devReqTextOfMessage(msgs[i]);
    if (req) return req.length > 160 ? req.slice(0, 160) + "…" : req;
  }
  return "";
}

/* 该工具的内部子图统计：直属子节点数 + 两端都在该工具内部的连线数
   （只读展示用；会话真正改动时以 canvas_get / canvas_edit 为准） */
function toolDevInnerGraphInfo(node) {
  if (!node || !S.wf) return I18n.t("（空）");
  const kids =
    typeof superChildrenOf === "function" ? superChildrenOf(node.id) : [];
  const ids = new Set([node.id]);
  for (const k of kids || []) ids.add(k.id);
  let wires = 0;
  for (const w of S.wf.wires || []) {
    if (w.rel) continue;
    if (ids.has(w.from) && ids.has(w.to)) wires++;
  }
  if (!kids.length)
    return I18n.t("（尚无内部节点：会话会按入出参从零搭建内部子图）");
  return (
    kids.length +
    I18n.t(" 个内部节点 / ") +
    wires +
    I18n.t(" 条内部连线")
  );
}

/* 工具开发任务书 = 该会话的契约（写进 session._devContract，每轮随系统提示注入）：
   前半是现状（工具名 / 描述 / 参数即端子 / 内部子图），后半是钉死的边界。 */
function toolDevContractText(node, req) {
  ensureFnToolNodeState(node);
  const name = toolDevNameOf(node) || I18n.t("未命名工具");
  const c =
    node.toolConfig && typeof node.toolConfig === "object"
      ? node.toolConfig
      : {};
  const ins = fnToolParamList(node, "in");
  const outs = fnToolParamList(node, "out");
  const lines = [];
  lines.push(
    I18n.t("【工具开发任务书】") +
      " " +
      name +
      "（" +
      I18n.t("工具节点") +
      (String(node.title || "").trim() && node.title !== name
        ? I18n.t(" · 标题：") + node.title
        : "") +
      "）",
  );
  lines.push(
    I18n.t("工具描述（toolConfig.description · 给 Agent 看的用途说明）：") +
      (String(c.description || "").trim() || I18n.t("（无）")),
  );
  lines.push(
    I18n.t("入参端子（端子 0 = 控制入，1..N = 各入参）：") +
      fnDevParamLine(ins, 1, true),
  );
  lines.push(
    I18n.t("出参端子（0..M-1 = 各出参，末位 = 控制出）：") +
      fnDevParamLine(outs, 0),
  );
  lines.push(
    I18n.t("内部子图：") +
      toolDevInnerGraphInfo(node) +
      I18n.t("（工具的行为 = 它的内部子图：点 ▶ 或 Agent 调用时按拓扑执行）"),
  );
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  if (reqText) lines.push(I18n.t("本次开发需求：") + reqText);
  lines.push(
    I18n.t(
      "本会话由该工具节点的「开发」按钮新建，只负责这一个工具节点（含其内部子图）；请以画布上该节点与内部子图的真实配置为准，不要臆测，也不要顺手扩展无关功能。",
    ),
  );
  lines.push(
    I18n.t(
      "改动边界（必须严格遵守）：① 先用 mtnode_canvas_get 读该工具节点现状（detail:\"full\"、ids:[本节点标题]；内部子图节点会随画布快照返回），再动手；② 对工具定义用 mtnode_canvas_edit 的 update 补丁本工具节点的 toolConfig（name / description / inputs / outputs，必要时 setTitle 同步工具名）；调整工具行为则在**本工具内部**新建 / 删除 / 改动节点并连线（这些子节点 parentSuperId = 本工具 id，本会话创建的子节点也必须挂在它下面）；③ 不得新建、删除或改动任何其它画布节点，也不得增删本工具内外部之外的连线；④「参数即端子」——改 toolConfig 的 inputs / outputs 参数表就是改端子，端子数一变已连的线就可能改指别的端子，因此只要动了参数表，就必须在回复里明确提醒用户回画布复核该节点的连线。",
    ),
  );
  lines.push(
    I18n.t("本节点标题（mtnode_canvas_get 的 ids 与 update 的定位就用它）：") +
      (String(node.title || "").trim() || name) +
      " · id=" +
      node.id,
  );
  lines.push(
    I18n.t(
      "运行语义：工具节点 = super + tool:true 变体，Agent 调用 / 画布 ▶ 执行的都是它的内部子图（先补跑上游，再按拓扑执行内部节点），内部没有可执行节点会报「工具节点内部没有可执行的节点」。内部子图里想放什么就放什么（文本处理 / 智能任务 / 函数 / 保存等），输出要接回本工具的外侧输出端子（内侧汇流），入参由外侧输入端子（参数即端子）注入。",
    ),
  );
  lines.push(
    I18n.t(
      "需求不明确时先问用户再动手；改完用一句话汇报改了什么（是否动了参数表）。",
    ),
  );
  lines.push(
    I18n.t(
      "本次开发需求已在任务书中一次性完整给出：请按此执行，不要分两次会话输入重复提交（重复输入会造成上下文割裂与重复开工）。",
    ),
  );
  return lines.join("\n");
}

/* 每次「开发」都新建会话运行：上下文干净，工作区 = 节点所属画布目录，
   provider / model / effort 跟随用户当前默认（不硬编模型）。 */
function createToolDevSessionForNode(node, req) {
  if (!node || !isToolNode(node)) return null;
  const cur =
    typeof agentSessionById === "function"
      ? agentSessionById(S.agentActiveId)
      : null;
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  const sess = {
    id: uid("as"),
    title:
      I18n.t("开发 · ") + (toolDevNameOf(node) || I18n.t("未命名工具")),
    workspace: dshWorkspaceOf(node) || "",
    /* 工具开发会话：所属画布 = 该工具节点所在画布 */
    canvasWfId: canvasWfIdForNode(node),
    preset: (cur && cur.preset) || AGENT_PRESET_DEFAULT,
    provider: (cur && cur.provider) || "deepseek-official",
    model: (cur && cur.model) || "",
    effort: (cur && cur.effort) || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  sess._devContract = toolDevContractText(node, reqText);
  sess.messages.unshift({
    role: "user",
    content: reqText
      ? I18n.t("本次开发需求：") + reqText
      : sess._devContract,
    _src: "dev-node",
    _nid: node.id,
  });
  agentSessions().unshift(sess);
  if (!Array.isArray(node.toolDevSessionIds)) node.toolDevSessionIds = [];
  node.toolDevSessionIds.unshift(sess.id);
  while (node.toolDevSessionIds.length > 24) node.toolDevSessionIds.pop();
  return sess;
}

/* 「开发」（工具节点 body 下方按钮）：弹窗展示现状 + 填写本次要改 / 扩展的内容
   → 确认后新建绑定该工具的会话并在其中运行（留在画布，不跳会话视图）。 */
async function developToolNode(node) {
  if (!node || !isToolNode(node)) return;
  ensureFnToolNodeState(node);
  const name = toolDevNameOf(node) || I18n.t("未命名工具");
  const ws = dshWorkspaceOf(node) || "";
  const rows = [
    [I18n.t("工具名"), name],
    [I18n.t("节点标题"), node.title || I18n.t("（未命名）")],
    [
      I18n.t("描述"),
      String((node.toolConfig && node.toolConfig.description) || "").trim() ||
        I18n.t("（无）"),
    ],
    [
      I18n.t("入参端子"),
      fnDevParamLine(fnToolParamList(node, "in"), 1) +
        "（" +
        I18n.t("端子 0 = 控制入") +
        "）",
    ],
    [
      I18n.t("出参端子"),
      fnDevParamLine(fnToolParamList(node, "out"), 0) +
        "（" +
        I18n.t("末位 = 控制出") +
        "）",
    ],
    [I18n.t("内部子图"), toolDevInnerGraphInfo(node)],
    [I18n.t("会话工作区"), ws || I18n.t("（应用默认数据目录）")],
  ];
  const last = toolDevLastRequestOf(node);
  if (last) rows.push([I18n.t("最近一次要求"), last]);
  const res = await mtDialogForm({
    title: I18n.t("开发") + " · " + name,
    wide: true,
    rows,
    msg: I18n.t(
      "请说明本次要修改或扩展这个工具的哪些行为；确认后将新建一个绑定该工具的会话并在其中运行（可改 toolConfig 参数 / 描述，也可重建内部子图）。",
    ),
    warn: I18n.t(
      "该工具的行为 = 它的内部子图：会话可以按现有入出参从零搭建内部子图，也可以只调参数 / 描述不改内部图。",
    ),
    textarea: devDraftTextareaOpts(node, "toolDev", {
      label: I18n.t("本次希望修改 / 扩展的内容"),
      placeholder: I18n.t(
        "例如：把内部子图换成先提取关键词再查库的两段流程；新增一个 image 入参并透传到内部函数节点；出错时返回错误文本而不是抛异常…",
      ),
      rows: 6,
      requiredMsg: I18n.t("请填写本次希望修改或扩展的内容"),
    }),
    onText: (t) => devDraftSet(node, "toolDev", t),
    hint: I18n.t(
      "确认 = 新会话后台运行（工作区 = 画布目录 · 标题「开发 · 工具名」· 只改这一个工具节点与它的内部子图 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消",
    ),
    requireText: true,
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "go", label: I18n.t("开始开发"), primary: true },
    ],
  });
  if (!res || res.action !== "go") return;
  devDraftSet(node, "toolDev", "");
  const body = String(res.text || "").trim();
  if (!body) return;
  const sess = createToolDevSessionForNode(node, body);
  if (!sess) return;
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  renderCanvas();
  if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
  toast(
    I18n.t("已创建工具开发会话「") +
      (sess.title || "") +
      I18n.t("」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）"),
    "ok",
  );
  try {
    await agentSessionSend("", { _devContract: true });
  } catch (err) {
    toast(
      I18n.t("开发会话启动失败：") + ((err && err.message) || String(err)),
      "err",
    );
  }
}

