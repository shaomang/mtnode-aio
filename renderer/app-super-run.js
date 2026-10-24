/* renderer/app-super-run.js — 节点层「运行本层」（▶）
 * ============================================================================
 * 需求：节点层的头部多一颗 ▶ —— 点一下就把层内所有可执行节点按「上游 → 下游」
 *      依次跑一遍（效果等同于把一颗执行节点接到了所有节点上）。
 *
 * 共识口径（与用户逐条确认过，改口径前先问）：
 *   · 执行范围 = 工具节点内部图那一套（app-nodes.js 的 runToolNode）：
 *       proc_text / proc_image、agent_task、媒体生成（含 video 后处理、remotion、
 *       breeze / sensenova）、函数 / 工具、保存、task、net_send / net_recv；
 *       输入 / 素材 / 拆分 / 合并只穿过，wait_file 与纯控制类、执行节点（启动外部
 *       exe）不跑。
 *   · 顺序 = 严格串行：一个跑完再下一个；顺序取连线的拓扑序，同层并列按画布
 *      自上而下（y，其次 x）。
 *   · 层内套层 = 递归摊平到底层；但**工具节点整体当一颗跑**（它自己是执行引擎，
 *       摊开会废掉参数契约与输出写回），**长任务壳整棵跳过**（由状态机驱动）。
 *       跨壳时以父层顺序为准：子壳内的节点作为连续一段跑完，再跑下一个父层节点。
 *   · 已有输出：开跑前问一次「将覆盖 N 个已有输出」。
 *   · 层内已有节点在跑 / 排队：提示并中止整层（一个都不启动）。
 *   · 某节点失败：立即中止整层，已完成节点的输出保留，未跑的不动。
 *   · ■ = 不再启动剩余节点，正在跑的那个继续（要立刻掐断用顶栏「全部终止」）。
 *
 * 执行本体直接复用 app-nodes.js 的 runCascadeNode（工具节点 / 自动级联同一条通路），
 * 本文件只负责「摊平 + 排序 + 批次控制 + 界面反馈」，不另造一套节点执行器。
 * ============================================================================ */

/* 运行态：shellId -> { stopping, done, total, epoch }
   epoch = 发车时的 GLOBAL_STOP_SEQ：期间点过「全部终止」就不再启动剩余节点。 */
const SUPER_RUN_STATE = new Map();
/* 正在跑的那一颗节点（画布上打高亮）：nodeId 集合 */
const SUPER_RUN_FOCUS = new Set();

function superRunStateOf(shell) {
  return shell && shell.id ? SUPER_RUN_STATE.get(shell.id) || null : null;
}

function superRunIsFocusNode(nodeId) {
  return !!nodeId && SUPER_RUN_FOCUS.has(String(nodeId));
}

/* 长任务壳（super + ltShellTask）：由长周期任务状态机驱动，一键跑会跟引擎抢同一批节点 */
function superRunIsLtShell(n) {
  return !!(n && n.kind === "super" && String(n.ltShellTask || "").trim());
}

/* 可执行叶子：口径同 runToolNode 的内部可运行子图（见文件头） */
function superRunIsLeafRunnable(n) {
  if (!n || isSuperIoNode(n)) return false;
  if (n.kind === "wait_file" || n.kind === "execute") return false;
  return !!(
    isAutoProcKind(n) ||
    isMediaGenNode(n) ||
    isComputeExecKind(n) ||
    isSaveNode(n) ||
    n.kind === "net_recv" ||
    n.kind === "net_send"
  );
}

/* 需要摊开的容器壳：普通 / 开发 / 数据库节点层。
   工具节点（super + tool:true）不摊开 —— 它自己是执行引擎，整体当一颗跑。 */
function superRunIsContainer(n) {
  if (!n || n.kind !== "super" || isSuperIoNode(n)) return false;
  if (isToolNode(n)) return false;
  if (superRunIsLtShell(n)) return false;
  return true;
}

/* 同级单位排序：连线拓扑序（数据线 / 控制线都算先后），并列按画布自上而下。
   环路退化为「剩余节点按 y 依次放行」，与 controlRunLayers 的兜底同口径。 */
function superRunOrderSiblings(list) {
  const units = Array.isArray(list) ? list.filter(Boolean) : [];
  if (units.length < 2) return units.slice();
  const ids = new Set(units.map((n) => n.id));
  const byY = (a, b) =>
    (Number(a.y) || 0) - (Number(b.y) || 0) ||
    (Number(a.x) || 0) - (Number(b.x) || 0);
  const adj = new Map(units.map((n) => [n.id, []]));
  const indeg = new Map(units.map((n) => [n.id, 0]));
  const seenEdge = new Set();
  for (const w of (S.wf && S.wf.wires) || []) {
    if (!w || w.rel) continue;
    if (!ids.has(w.from) || !ids.has(w.to) || w.from === w.to) continue;
    const key = w.from + ">" + w.to;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    adj.get(w.from).push(w.to);
    indeg.set(w.to, (indeg.get(w.to) || 0) + 1);
  }
  const out = [];
  const placed = new Set();
  const ready = units.filter((n) => !indeg.get(n.id)).sort(byY);
  while (out.length < units.length) {
    if (!ready.length) {
      /* 环路：剩下的按 y 依次放行，绝不空转 */
      const rest = units.filter((n) => !placed.has(n.id)).sort(byY);
      for (const n of rest) {
        placed.add(n.id);
        out.push(n);
      }
      break;
    }
    const n = ready.shift();
    if (!n || placed.has(n.id)) continue;
    placed.add(n.id);
    out.push(n);
    for (const toId of adj.get(n.id) || []) {
      indeg.set(toId, (indeg.get(toId) || 0) - 1);
      if (indeg.get(toId)) continue;
      const t = units.find((x) => x.id === toId);
      if (t && !placed.has(t.id)) {
        ready.push(t);
        ready.sort(byY);
      }
    }
  }
  return out;
}

/* 摊平整棵子树 → 一棵「按执行先后排好」的叶子列表 */
function superRunCollect(host) {
  const out = [];
  if (!host || !host.id || !S || !S.wf) return out;
  const walk = (shell) => {
    const sibs = (superChildrenOf(shell.id) || []).filter(
      (c) => c && !isSuperIoNode(c) && !superRunIsLtShell(c),
    );
    const units = sibs.filter(
      (c) => superRunIsLeafRunnable(c) || superRunIsContainer(c),
    );
    for (const u of superRunOrderSiblings(units)) {
      if (superRunIsContainer(u)) walk(u);
      else out.push(u);
    }
  };
  walk(host);
  return out;
}

/* 这一颗算不算「跑失败」：报错 / 被终止一定算；该出内容的节点没出内容也算；
   保存按是否落到盘上判，任务按它自己的状态判，网络收发不要求输出。 */
function superRunNodeFailed(n) {
  if (!n) return false;
  if (n._aborted) return true;
  if (n.error) return true;
  if (isSaveNode(n))
    return !(
      n.savedPath ||
      (Array.isArray(n.savedPaths) && n.savedPaths.length)
    );
  if (n.kind === "task") return n.taskStatus === "failed";
  if (n.kind === "net_recv" || n.kind === "net_send") return false;
  if (isAutoProcKind(n) || isMediaGenNode(n) || isComputeExecKind(n))
    return !nodeHasOutputContent(n);
  return false;
}

/* 画布上某颗节点的元素（`dataset.nid` 是唯一真源；不拼选择器，避免 id 里的特殊字符） */
function superRunNodeEl(nodeId) {
  const id = String(nodeId == null ? "" : nodeId);
  if (!id) return null;
  const all = document.querySelectorAll(".wf-node");
  for (const el of all) if (el.dataset && el.dataset.nid === id) return el;
  return null;
}

/* 当前节点高亮：只改现场那两颗元素的类，不整图重画 */
function superRunPaintFocus(nodeId, on) {
  const id = String(nodeId == null ? "" : nodeId);
  if (!id) return;
  if (on) SUPER_RUN_FOCUS.add(id);
  else SUPER_RUN_FOCUS.delete(id);
  const el = superRunNodeEl(id);
  if (el) el.classList.toggle("super-run-focus", !!on);
}

/* 进度只在按钮上就地更新（n/N），避免每跑一颗就整图重画 */
function superRunPaintProgress(shell) {
  const el = shell ? superRunNodeEl(shell.id) : null;
  const btn = el ? el.querySelector(".n-super-run") : null;
  const st = superRunStateOf(shell);
  if (!btn) return;
  if (!st) {
    btn.textContent = "▶";
    btn.classList.remove("running", "progress");
    return;
  }
  btn.textContent = Math.min(st.done, st.total) + "/" + st.total;
  btn.classList.add("running", "progress");
}

/* 节点头部那颗 ▶（↪ 左侧）：运行中变成 n/N，并多一颗 ■ */
function superRunHeadButton(node) {
  const wrap = document.createElement("span");
  wrap.className = "n-super-run-wrap";
  const st = superRunStateOf(node);
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "n-play n-super-run" + (st ? " running progress" : "");
  b.textContent = st ? Math.min(st.done, st.total) + "/" + st.total : "▶";
  b.title = st
    ? I18n.t("正在运行本层：已跑完 ") +
      st.done +
      "/" +
      st.total +
      I18n.t("（点右侧 ■ 可停止启动剩余节点）")
    : I18n.t(
        "运行本层：把层内所有可执行节点按上游→下游依次跑一遍（长任务壳不参与）",
      );
  b.setAttribute("aria-label", b.title);
  if (st) {
    /* 运行中：这颗只显示进度，点了什么也不做（不重复发车），但要吞掉事件，
       否则指针会落到底下的节点上、变成拖拽 / 选中。 */
    b.setAttribute("aria-disabled", "true");
    b.onclick = (ev) => ev.stopPropagation();
  } else {
    b.onclick = (ev) => {
      ev.stopPropagation();
      runSuperLayer(node);
    };
  }
  wrap.appendChild(b);
  if (st) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "n-play n-stop";
    stop.title = I18n.t("停止运行本层：不再启动剩余节点（正在跑的那个继续）");
    stop.setAttribute("aria-label", stop.title);
    stop.onclick = (ev) => {
      ev.stopPropagation();
      superRunStop(node);
    };
    wrap.appendChild(stop);
  }
  return wrap;
}

function superRunStop(shell) {
  const st = superRunStateOf(shell);
  if (!st) return;
  st.stopping = true;
  superRunPaintProgress(shell);
  /* 回执只在批次收尾时给一条（「已停止本层运行：完成 n/N」）——
     toast 只显示 err / warn 两档（app.js 的 TOAST_KINDS_SHOWN），这里不重复打扰。 */
}

/* 入口：跑一整层 */
async function runSuperLayer(shell) {
  if (!shell || shell.kind !== "super") return;
  if (superRunIsLtShell(shell)) {
    toast(I18n.t("长任务壳由状态机驱动，不能整层一键运行"), "warn");
    return;
  }
  if (superRunStateOf(shell)) {
    toast(I18n.t("本层正在运行中：等它跑完，或点 ■ 停止"), "warn");
    return;
  }
  const list = superRunCollect(shell);
  if (!list.length) {
    toast(I18n.t("这一层里没有可执行的节点"), "warn");
    return;
  }
  /* 冲突：层内已有节点在跑 / 排队 → 一个都不启动（共识：提示并中止整层） */
  const busy = list.filter((n) => n && (n.running || isNodePending(n)));
  if (busy.length) {
    toast(
      I18n.t("层内已有节点正在运行或在排队：") +
        I18n.listJoin(busy.slice(0, 6).map((n) => n.title || n.kind)) +
        I18n.t("。等它跑完再运行本层。"),
      "warn",
    );
    return;
  }
  /* 已有输出 → 开跑前问一次（只问一次，不逐节点打断） */
  const occupied = list.filter((n) => nodeHasOutputContent(n));
  if (occupied.length) {
    const titles = occupied.map((n) => n.title || n.kind);
    const shown = titles.slice(0, 8);
    const more =
      titles.length > shown.length
        ? I18n.t(" 等 ") + titles.length + I18n.t(" 个")
        : "";
    const go = await confirmDialog(
      I18n.t("将覆盖 ") +
        occupied.length +
        I18n.t(" 个已有输出，继续运行本层？（") +
        I18n.listJoin(shown) +
        more +
        "）",
      {
        title: I18n.t("运行本层"),
        okText: I18n.t("覆盖并运行"),
        cancelText: I18n.t("取消"),
      },
    );
    if (!go) return;
  }

  const st = {
    done: 0,
    total: list.length,
    stopping: false,
    epoch: GLOBAL_STOP_SEQ,
  };
  SUPER_RUN_STATE.set(shell.id, st);
  const pending = new Set(list.map((n) => n.id));
  invalidateControlRunTargets(list);
  addPendingRun(pending);
  const seen = new Set();
  let failed = null;
  superRunPaintProgress(shell);
  try {
    for (const n of list) {
      if (st.stopping) break;
      /* 期间点过「全部终止」：与本地 ■ 同待遇，不再启动剩余节点 */
      if (GLOBAL_STOP_SEQ !== st.epoch) {
        st.stopping = true;
        break;
      }
      const live = nodeById(n.id);
      if (!live || live.running) continue;
      superRunPaintFocus(live.id, true);
      try {
        await runCascadeNode(live, seen);
      } catch (e) {
        /* 执行器内部的意外异常也按「这一颗失败」处理，不允许把整层挂住 */
        live.error = live.error || (e && e.message) || String(e);
      }
      superRunPaintFocus(live.id, false);
      st.done++;
      superRunPaintProgress(shell);
      if (superRunNodeFailed(live)) {
        failed = live;
        break;
      }
    }
  } finally {
    clearPendingRun(pending);
    SUPER_RUN_STATE.delete(shell.id);
    renderCanvas();
    renderStatus();
  }
  if (failed) {
    toast(
      I18n.t("本层运行中止：") +
        (failed.title || failed.kind) +
        I18n.t(" 失败 —— ") +
        (failed.error || I18n.t("没有产出内容")) +
        I18n.t("（已完成 ") +
        st.done +
        "/" +
        st.total +
        I18n.t("）"),
      "err",
    );
  } else if (st.stopping) {
    toast(I18n.t("已停止本层运行：完成 ") + st.done + "/" + st.total, "warn");
  }
  /* 顺利跑完不弹窗：本仓 toast 只显示 err / warn 两档（app.js 的 TOAST_KINDS_SHOWN），
     完成信号就是按钮从 n/N 回到 ▶ —— 想加成功提示得另开一条可见通道，先不扩。 */
}
