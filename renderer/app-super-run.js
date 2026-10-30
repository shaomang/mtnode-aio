/* renderer/app-super-run.js — 节点层「运行本层」（▶）
 * ============================================================================
 * 需求：节点层的头部多一颗 ▶ —— 点一下就把层内所有可执行节点按「上游 → 下游」
 *      依次跑一遍（效果等同于把一颗执行节点接到了所有节点上）。
 *
 * 共识口径（与用户逐条确认过，改口径前先问）：
 *   · 执行范围 = 工具节点内部图那一套（app-nodes.js 的 runToolNode）：
 *       proc_text / proc_image、agent_task、媒体生成（含 video 后处理、remotion、
 *       breeze）、函数 / 工具、保存、task、net_send / net_recv；
 *       输入 / 素材 / 拆分 / 合并只穿过，wait_file 与纯控制类、执行节点（启动外部
 *       exe）不跑。
 *   · 顺序 = 严格串行：一个跑完再下一个；顺序取连线的拓扑序，同层并列按画布
 *      自上而下（y，其次 x）。
 *   · 层内套层 = 递归摊平到底层；但**工具节点整体当一颗跑**（它自己是执行引擎，
 *       摊开会废掉参数契约与输出写回），**长任务壳整棵跳过**（由状态机驱动）。
 *       跨壳时以父层顺序为准：子壳内的节点作为连续一段跑完，再跑下一个父层节点。
 *   · 已有输出：开跑前问一次「将覆盖 N 个已有输出」。
 *   · 层内已有节点在跑 / 排队：提示并中止整层（一个都不启动）。
 *   · **某节点失败：本层就地暂停，不再中止整层**（本次修的就是这条）：
 *       头部 ▶ 区变成「继续」+ 保留 ■「停止」，剩余节点一个都不启动；
 *       失败那颗由用户手动跑成功（有产出、无 error）后「继续」才可点（否则置灰）；
 *       点「继续」时把受影响的下游子树列出来由用户勾选「一并跳过 / 还是跑」；
 *       暂停期间本层剩余节点不由其它批次（控制节点 ▶ / 自动级联）启动。
 *   · **失败分档**（superRunFailureOf）：
 *       error / empty（真报错 / 没产出）→ 自动重试 1 次再判失败；
 *       cancelled（被终止 / 生成任务被取消）→ 不重试，直接进暂停。
 *   · **■ 与顶栏「全部终止」= 直接退出本层**（不进暂停、不留继续键），
 *       并且正在跑的那一颗当场中止（走 stopNode：取消模型请求 / 后端生成，
 *       不等它自然跑完 —— 见 superRunAbortCurrent）。
 *   · 留痕：失败节点自己的状态行 + 壳卡片底部只读小字 + 左下角运行队列；
 *       本层运行期间捕获到的渲染层未捕获异常也算本层的中断原因。
 *   · 暂停态只活在内存（SUPER_RUN_STATE）：关应用即作废，重开后需重新 ▶。
 *
 * 执行本体直接复用 app-nodes.js 的 runCascadeNode（工具节点 / 自动级联同一条通路），
 * 本文件只负责「摊平 + 排序 + 批次控制 + 暂停/继续 + 界面反馈」，不另造一套节点执行器。
 * ============================================================================ */

/* 运行态：shellId -> state
   { phase:"running"|"paused", done, total, stopping, epoch, remaining:Set,
     orderIds:Set, currentTitle, failed:{id,title,kind,reason,kindOf}, failures[],
     skipped:Set, retried:Set, abnormal[] } */
const SUPER_RUN_STATE = new Map();
/* 正在跑的那一颗节点（画布上打高亮）：nodeId 集合 */
const SUPER_RUN_FOCUS = new Set();
/* 最近一次收尾汇总（壳卡片底部那行只读小字，shellId -> 文本）：下次发车时清掉 */
const SUPER_RUN_SUMMARY = new Map();

/* 终止类文案：这类「失败」是被人 / 全局终止打断的，不重试，但同样进暂停等人工 */
const SUPER_RUN_STOP_TEXT =
  /已终止|已取消|已手动停止|已请求终止|手动终止|自动终止|已停止|中止|cancel|abort/i;

/* ── 本层批次 = 一张「调度表」（与 runControlRunnableQueue 同一口径）────────────
   为什么必须有它（本 bug 的根因）：等待态 S.pendingRun 只是展示用的集合，
   app-nodes.js 的 sweepOrphanPendingRuns 会定期自愈 —— 判据只认四类「真的还有人在等」
   的证据：媒体串行链 mediaGenWaiters / 计算执行闸 computeExecWaiters·Slots /
   S._scheduledRunIds / 运行体 S.runPromises。
   「运行本层」旧写法只调 addPendingRun(整批)，却没有把这批登记进调度表，于是第一次
   取数（updateRunQueuePanel → collectRunQueue → sweepOrphanPendingRuns）就把整批等待态
   当成幽灵全删了：左下角运行队列看不到这一批「等待中」，内部节点的等待态也跟着不同步。
   登记 → 收尾恢复；与控制批次同时跑时取并集，避免把对方那份保护挤掉。 */
function superRunScheduledRegister(ids) {
  if (!S) return null;
  const prev = S._scheduledRunIds;
  const next = new Set(ids || []);
  if (prev) for (const id of prev) next.add(id);
  S._scheduledRunIds = next;
  return { prev, next };
}
function superRunScheduledRestore(reg) {
  if (!reg || !S) return;
  /* 期间可能被嵌套批次（工具节点内部图 / 自动级联）换过又还原回来：
      只有还挂着我们这份时才还原，绝不覆盖别人正在用的调度表。 */
  if (S._scheduledRunIds === reg.next) S._scheduledRunIds = reg.prev;
}

function superRunStateOf(shell) {
  return shell && shell.id ? SUPER_RUN_STATE.get(shell.id) || null : null;
}

function superRunIsFocusNode(nodeId) {
  return !!nodeId && SUPER_RUN_FOCUS.has(String(nodeId));
}

/* 这一层是否正在「运行本层」（画布上给壳加呼吸灯：.super-run-live）
   暂停期间仍然算「本层未结束」：呼吸灯不灭，用户一眼看出它还在等着。 */
function superRunIsRunningShell(nodeId) {
  return !!nodeId && SUPER_RUN_STATE.has(String(nodeId));
}

/* 暂停中的本层是否锁着这颗节点（其它批次不许启动它）。
   返回壳 id（空了就是没锁）：给 app-nodes.js 的 playNodeBody 当闸门用。 */
function superRunNodeLockedBy(nodeId) {
  const id = String(nodeId == null ? "" : nodeId);
  if (!id) return "";
  for (const [shellId, st] of SUPER_RUN_STATE) {
    if (!st || st.phase !== "paused") continue;
    if (st.remaining && st.remaining.has(id)) return shellId;
  }
  return "";
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

/* 媒体族节点自己那行状态（musicStatus / videoStatus …）：取消类失败只写在这里，
   error 是 null —— 所以失败判定必须看得到它。 */
function superRunMediaStatusOf(node) {
  if (!node) return "";
  const keys = [
    "musicStatus",
    "yueStatus",
    "breezeStatus",
    "flux3kleinStatus",
    "qwenimageStatus",
    "videoStatus",
    "remotionStatus",
  ];
  for (const k of keys) {
    const v = String(node[k] || "").trim();
    if (v) return v;
  }
  return "";
}

/* 这一颗算不算「跑失败」，以及失败属于哪一档：
   · error      真报错（有 error 文本）→ 可自动重试 1 次
   · empty      该出内容却没出（含保存没落盘、任务失败）→ 可自动重试 1 次
   · cancelled  被终止 / 生成任务被取消 → 不重试
   返回 null = 通过。 */
function superRunFailureOf(node) {
  if (!node) return null;
  const stopText = (t) => SUPER_RUN_STOP_TEXT.test(String(t || ""));
  if (node._aborted)
    return { kind: "cancelled", reason: I18n.t("被终止"), retryable: false };
  const err = String(node.error || "").trim();
  if (err) {
    const cancelled = stopText(err);
    return {
      kind: cancelled ? "cancelled" : "error",
      reason: err,
      retryable: !cancelled,
    };
  }
  if (isSaveNode(node)) {
    if (node.savedPath || (Array.isArray(node.savedPaths) && node.savedPaths.length))
      return null;
    return { kind: "empty", reason: I18n.t("没有落盘"), retryable: true };
  }
  if (node.kind === "task") {
    if (node.taskStatus === "failed")
      return { kind: "error", reason: I18n.t("任务失败"), retryable: true };
    return null;
  }
  if (node.kind === "net_recv" || node.kind === "net_send") return null;
  if (isMediaGenNode(node)) {
    /* 排队项被作废 / 在途任务被取消：媒体节点只写状态行、error 为 null
       （app-nodes.js 的 mediaGenMarkDropped）—— 不认这条就会误报成「没有产出内容」 */
    const st = superRunMediaStatusOf(node);
    if (st && stopText(st) && !nodeHasOutputContent(node))
      return { kind: "cancelled", reason: st, retryable: false };
  }
  if (isAutoProcKind(node) || isMediaGenNode(node) || isComputeExecKind(node)) {
    if (!nodeHasOutputContent(node))
      return { kind: "empty", reason: I18n.t("没有产出内容"), retryable: true };
    return null;
  }
  return null;
}

/* 兼容旧调用：这一颗是不是失败（判定细则见 superRunFailureOf） */
function superRunNodeFailed(n) {
  return !!superRunFailureOf(n);
}

/* 「继续」的门槛：失败那颗必须已经手动跑成功（有产出、无 error / 无取消状态） */
function superRunResumeReady(node) {
  return !!node && !superRunFailureOf(node);
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

/* 正在跑 / 暂停的那一层：壳上挂 / 摘 .super-run-live（呼吸灯，见 canvas.css）。
   只改现场元素；整图重画时由 app-canvas.js 按 superRunIsRunningShell 补回来。 */
function superRunPaintShell(shell, on) {
  const el = shell ? superRunNodeEl(shell.id) : null;
  if (el) el.classList.toggle("super-run-live", !!on);
}

/* 进度只在按钮上就地更新（n/N），避免每跑一颗就整图重画。
   暂停态那颗键已经是「继续」，不许被进度覆盖（改了文字用户就找不到继续入口）。 */
function superRunPaintProgress(shell) {
  const el = shell ? superRunNodeEl(shell.id) : null;
  const btn = el ? el.querySelector(".n-super-run") : null;
  const st = superRunStateOf(shell);
  if (!btn || (st && st.phase === "paused")) return;
  if (!st) {
    btn.textContent = "▶";
    btn.classList.remove("running", "progress");
    return;
  }
  btn.textContent = Math.min(st.done, st.total) + "/" + st.total;
  btn.classList.add("running", "progress");
}

/* 进度文案：`3/8` */
function superRunProgressText(st) {
  if (!st) return "";
  return Math.min(st.done, st.total) + "/" + st.total;
}

/* 本层状态行文案（壳卡片底部小字 / 运行队列行都用它） */
function superRunStateText(st) {
  if (!st) return "";
  const p = superRunProgressText(st);
  if (st.phase === "paused" && st.failed) {
    const who = st.failed.title || st.failed.kind || "";
    return (
      I18n.t("已暂停 ") +
      p +
      " · " +
      who +
      I18n.t(" 失败：") +
      (st.failed.reason || I18n.t("没有产出内容"))
    );
  }
  const cur = st.currentTitle ? I18n.t(" · 正在跑 ") + st.currentTitle : "";
  return I18n.t("运行本层 ") + p + cur;
}

/* 壳卡片底部那行只读小字（app-canvas.js 的折叠卡调用）：
   运行中 / 暂停中显示本层状态，跑完显示最近一次汇总（下次发车时清掉）。 */
function superRunStatusLineEl(node) {
  if (!node || !node.id) return null;
  const st = superRunStateOf(node);
  const sum = SUPER_RUN_SUMMARY.get(String(node.id)) || "";
  const text = st ? superRunStateText(st) : sum;
  if (!text) return null;
  const el = document.createElement("div");
  el.className =
    "super-run-status" +
    (st ? (st.phase === "paused" ? " paused" : " live") : " done");
  el.textContent = text;
  el.title = text;
  return el;
}

/* 左下角「运行队列」用的本层条目（app.js 的 collectRunQueueAll 调用） */
function superRunQueueItems() {
  const out = [];
  for (const shellId of SUPER_RUN_STATE.keys()) {
    const st = SUPER_RUN_STATE.get(shellId);
    if (!st) continue;
    /* 跨画布也要出这一行：nodeById 只认当前画布，切走画布后本层这一行会凭空消失、
       切回来又出现（用户报的「切换画布任务消失」）。superRunShellById 连 S.wfBag 一起找。 */
    const shell = superRunShellById(shellId);
    if (!shell) continue;
    let w = null;
    try {
      w = typeof runQueueOwnerOf === "function" ? runQueueOwnerOf(shell) : null;
    } catch (_) {
      w = null;
    }
    const wfName = (w && (w.name || w.id)) || "";
    out.push({
      key: "layer:" + shellId,
      type: "layer",
      id: shellId,
      title: shell.title || I18n.t("（未命名节点层）"),
      kindCls: "super",
      kindLabel: I18n.t("节点层"),
      stateText: superRunStateText(st),
      sub: wfName,
      state: st.phase === "paused" ? "paused" : "run",
      wfId: (w && w.id) || "",
      wfName,
      /* 点行要先切回它归属的画布（jumpRunQueueItem 的 crossWf 分支） */
      crossWf: !!(w && S.wf && w.id !== S.wf.id),
      node: shell,
      sess: null,
    });
  }
  return out;
}

/* 本层里失败那颗的下游（连通可达、且在本批执行清单里）：勾选「一并跳过」的候选 */
function superRunDownstreamOf(st, nodeId) {
  const out = [];
  if (!st || !nodeId || !S || !S.wf) return out;
  const inBatch = st.orderIds || new Set();
  const adj = new Map();
  for (const w of S.wf.wires || []) {
    if (!w || w.rel || !w.from || !w.to || w.from === w.to) continue;
    if (!adj.has(w.from)) adj.set(w.from, []);
    adj.get(w.from).push(w.to);
  }
  const seen = new Set([String(nodeId)]);
  const queue = [String(nodeId)];
  while (queue.length) {
    const cur = queue.shift();
    for (const to of adj.get(cur) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
      if (inBatch.has(to) && !st.skipped.has(to)) {
        const n = typeof nodeById === "function" ? nodeById(to) : null;
        if (n) out.push(n);
      }
    }
  }
  return out;
}

/* 按壳 id 找壳（可能在别的画布上）：运行队列行来自跨画布批次时也能操作 */
function superRunShellById(shellId) {
  const id = String(shellId == null ? "" : shellId);
  if (!id) return null;
  const n = typeof nodeById === "function" ? nodeById(id) : null;
  if (n) return n;
  for (const wid of Object.keys((S && S.wfBag) || {})) {
    const w = S.wfBag[wid];
    const hit = ((w && w.nodes) || []).find((x) => x && x.id === id);
    if (hit) return hit;
  }
  return null;
}
/* 左下角运行队列行用：停止 / 继续（与壳头部两颗键同一条通路） */
function superRunStopById(shellId) {
  const shell = superRunShellById(shellId);
  if (shell) superRunStop(shell);
}
function superRunResumeById(shellId) {
  const shell = superRunShellById(shellId);
  if (shell) superRunResume(shell);
}

/* 节点头部那颗：▶ / n/N + ■；暂停态是「继续」+ ■ */
function superRunHeadButton(node) {
  const wrap = document.createElement("span");
  wrap.className = "n-super-run-wrap";
  const st = superRunStateOf(node);
  const paused = !!(st && st.phase === "paused");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "n-play n-super-run" + (st && !paused ? " running progress" : "");
  if (paused) {
    /* 暂停态：这颗键就是「继续」；失败那颗还没跑成功时置灰（门槛见 superRunResumeReady） */
    const failed = nodeById(st.failed && st.failed.id);
    const ready = superRunResumeReady(failed);
    b.classList.add("n-super-resume");
    b.textContent = I18n.t("继续");
    b.disabled = !ready;
    b.classList.toggle("disabled", !ready);
    b.title = ready
      ? I18n.t("继续运行本层：从暂停处接着跑剩下的节点")
      : I18n.t("还不能继续：先把「") +
        ((st.failed && st.failed.title) || "") +
        I18n.t("」手动跑成功（有产出、无报错）");
    b.setAttribute("aria-label", b.title);
    b.onclick = (ev) => {
      ev.stopPropagation();
      superRunResume(node);
    };
  } else if (st) {
    b.textContent = Math.min(st.done, st.total) + "/" + st.total;
    b.classList.add("progress");
    b.title =
      I18n.t("正在运行本层：已跑完 ") +
      st.done +
      "/" +
      st.total +
      I18n.t("（点右侧 ■ 可立即停止）");
    b.setAttribute("aria-label", b.title);
    /* 运行中：这颗只显示进度，点了什么也不做（不重复发车），但要吞掉事件，
       否则指针会落到底下的节点上、变成拖拽 / 选中。 */
    b.setAttribute("aria-disabled", "true");
    b.onclick = (ev) => ev.stopPropagation();
  } else {
    b.textContent = "▶";
    b.title = I18n.t(
      "运行本层：把层内所有可执行节点按上游→下游依次跑一遍（长任务壳不参与）",
    );
    b.setAttribute("aria-label", b.title);
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
    stop.title = paused
      ? I18n.t("停止本层：放弃剩余节点（暂停态一并作废）")
      : I18n.t("停止运行本层：立刻中止正在跑的节点，不再启动剩余节点");
    stop.setAttribute("aria-label", stop.title);
    stop.onclick = (ev) => {
      ev.stopPropagation();
      superRunStop(node);
    };
    wrap.appendChild(stop);
  }
  return wrap;
}

/* 记一次「本层运行期间的渲染层异常」（异常归因：本层中断原因之一） */
function superRunNoteAbnormal(text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  for (const st of SUPER_RUN_STATE.values()) {
    if (!st || !Array.isArray(st.abnormal) || st.abnormal.length >= 20) continue;
    st.abnormal.push(msg.slice(0, 300));
  }
}
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("error", (ev) => {
    if (!SUPER_RUN_STATE.size) return;
    superRunNoteAbnormal(
      (ev && (ev.message || (ev.error && ev.error.message))) || "",
    );
  });
  window.addEventListener("unhandledrejection", (ev) => {
    if (!SUPER_RUN_STATE.size) return;
    const r = ev && ev.reason;
    superRunNoteAbnormal(r && r.message ? r.message : String(r || ""));
  });
}

/* 立即中止本层「正在跑的那一颗」：节点级停止的唯一入口（app.js 的 stopNode）。
   dsh 模型请求 → dshCancelActive；媒体生成 → 取消后端任务；函数 / 工具 → 按 runId
   终止线程并回收进程树；普通处理节点 → apiAbort。旧写法只置 st.stopping 等它自己跑完，
   一次长模型请求要等几分钟 —— 用户看到的就是「停止无效 / 点了没反应」。 */
function superRunAbortCurrent(st) {
  if (!st) return;
  const id = String(st.currentId || "");
  if (!id) return;
  const node = superRunShellById(id);
  if (!node || typeof stopNode !== "function") return;
  try {
    const p = stopNode(node);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

function superRunStop(shell) {
  const st = superRunStateOf(shell);
  if (!st) return;
  st.stopping = true;
  /* 正在跑的那一颗立刻中止（不再等它自然跑完） */
  superRunAbortCurrent(st);
  /* 剩余节点的「排队等待中」当场撤下（用户口径：停了就不再启动剩余节点，
     队列里也不该继续挂着它们的等待行）。正在跑的那一颗不在 pending 里（起跑时自己
     摘掉了），已经进媒体串行链的那几颗也不摘 —— 那批活还在后端排队，摘了就等于看不见。 */
  if (st.remaining && st.remaining.size) {
    if (typeof clearPendingRun === "function") clearPendingRun(st.remaining);
    st.remaining.clear();
  }
  /* 暂停中点 ■ = 放弃本层：把等待中的「继续」当场结清，别让批次永远挂着 */
  superRunPauseSettle(st, "stop");
  superRunPaintProgress(shell);
  try {
    renderCanvas();
  } catch (_) {}
  try {
    updateRunQueuePanel();
  } catch (_) {}
  /* 回执只在批次收尾时给一条（「已停止本层运行：完成 n/N」）——
     toast 只显示 err / warn 两档（app.js 的 TOAST_KINDS_SHOWN），这里不重复打扰。 */
}

/* 「全部终止」要能命中本层：暂停中的层没有任何在跑的节点（队列里只有一条暂停行），
   stopAllRuns 的「没有运行中的任务」判空会直接返回，所以给它两个入口用的小判据。 */
function superRunHasActiveLayer() {
  return SUPER_RUN_STATE.size > 0;
}

/* 顶栏「全部终止」：所有本层一律退出（丢弃暂停 / 不再启动剩余节点），返回层数 */
function superRunStopAllLayers() {
  let n = 0;
  for (const st of SUPER_RUN_STATE.values()) {
    if (!st) continue;
    st.stopping = true;
    /* 正在跑的那一颗也要当场中止（顶栏「全部终止」的节点级扫描通常已经覆盖它，
       但本层自己也得动手：别指望别的入口替我们把这一颗停下来） */
    superRunAbortCurrent(st);
    if (st.remaining && st.remaining.size) {
      if (typeof clearPendingRun === "function") clearPendingRun(st.remaining);
      st.remaining.clear();
    }
    /* 暂停的层必须把「继续」等当场结清，否则批次永远挂着 */
    superRunPauseSettle(st, "stop");
    n++;
  }
  return n;
}

/* 结清一次暂停等待：stop = 放弃本层；continue = 往下跑 */
function superRunPauseSettle(st, outcome) {
  if (!st) return;
  if (st._pauseTimer) {
    try {
      clearInterval(st._pauseTimer);
    } catch (_) {}
    st._pauseTimer = null;
  }
  const resolve = st._resumeResolve;
  st._resumeResolve = null;
  if (resolve) resolve(outcome);
}

/* 进暂停：记失败、置相位、重画（头部的 ▶ 变成「继续」），然后等用户 */
function superRunPauseAt(st, shell, node, fail) {
  st.phase = "paused";
  st.currentTitle = "";
  st.failed = {
    id: node.id,
    title: node.title || node.kind || "",
    kind: node.kind,
    kindOf: fail && fail.kind,
    reason: (fail && fail.reason) || I18n.t("没有产出内容"),
  };
  st.failures.push({
    id: st.failed.id,
    title: st.failed.title,
    reason: st.failed.reason,
  });
  if (st.remaining) st.remaining.delete(node.id);
  try {
    renderCanvas();
  } catch (_) {}
  try {
    updateRunQueuePanel();
  } catch (_) {}
  return new Promise((resolve) => {
    st._resumeResolve = resolve;
    /* 顶栏「全部终止」不从我们这条链路里走：暂停期间用一拍轮询盯住全局终止代号，
       否则点了「全部终止」这一批会永远挂在暂停里（关不掉也跑不动）。 */
    st._pauseTimer = setInterval(() => {
      if (!st._resumeResolve) return;
      if (st.stopping || GLOBAL_STOP_SEQ !== st.epoch)
        superRunPauseSettle(st, "stop");
    }, 300);
  });
}

/* 「继续」入口：门槛 → （有下游就列出候选，由用户勾选）→ 放行 */
async function superRunResume(shell) {
  const st = superRunStateOf(shell);
  if (!st || st.phase !== "paused" || !st.failed) return;
  const node = typeof nodeById === "function" ? nodeById(st.failed.id) : null;
  if (!superRunResumeReady(node)) {
    toast(
      I18n.t("还不能继续：先把「") +
        (st.failed.title || "") +
        I18n.t("」手动跑成功（有产出、无报错）"),
      "warn",
    );
    return;
  }
  const cands = superRunDownstreamOf(st, st.failed.id);
  let skipIds = null;
  if (cands.length) {
    skipIds = await superRunAskSkipDownstream(st, shell, cands);
    if (!skipIds) return; /* 关掉选择窗 = 留在暂停，用户可以再来一次 */
  }
  if (skipIds) {
    for (const id of skipIds) {
      st.skipped.add(id);
      /* 勾了「一并跳过」就传递到它的整棵下游子树（上游没产出，下游跑也是空输入） */
      for (const d of superRunDownstreamOf(st, id)) {
        st.skipped.add(d.id);
        if (st.remaining) st.remaining.delete(d.id);
      }
      if (st.remaining) st.remaining.delete(id);
    }
  }
  st.done = Math.min(st.done + 1, st.total);
  st.phase = "running";
  st.failed = null;
  st.currentTitle = "";
  try {
    renderCanvas();
  } catch (_) {}
  try {
    updateRunQueuePanel();
  } catch (_) {}
  superRunPauseSettle(st, "continue");
}

/* 暂停时点「继续」→ 列出受影响的下游，由用户勾选「一并跳过」（默认全勾）。
   返回 Set<nodeId>（要跳过的）或 null（用户取消 → 留在暂停）。 */
function superRunAskSkipDownstream(st, shell, cands) {
  return new Promise((resolve) => {
    if (typeof openOverlay !== "function" || typeof $ !== "function") {
      resolve(new Set());
      return;
    }
    openOverlay(I18n.t("继续运行本层"), { persistent: true });
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        closeOverlay();
      } catch (_) {}
      resolve(val);
    };
    if (body) {
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "super-run-ask-msg";
      p.textContent =
        I18n.t("「") +
        ((st.failed && st.failed.title) || "") +
        I18n.t(
          "」已经跑成功。下面这些是它的下游（受影响的范围）：勾上的会连同它们的下游一起跳过，没勾的照常跑。",
        );
      body.appendChild(p);
      const list = document.createElement("div");
      list.className = "super-run-ask-list";
      for (const n of cands) {
        const row = document.createElement("label");
        row.className = "super-run-ask-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.value = String(n.id);
        const t = document.createElement("span");
        t.textContent = n.title || I18n.t("（未命名）");
        row.appendChild(cb);
        row.appendChild(t);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    if (foot) {
      foot.innerHTML = "";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "mini";
      cancel.textContent = I18n.t("取消（留在暂停）");
      cancel.onclick = () => finish(null);
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "mini primary";
      ok.textContent = I18n.t("继续运行");
      ok.onclick = () => {
        const picked = new Set();
        const boxes =
          body && body.querySelectorAll
            ? body.querySelectorAll('input[type="checkbox"]')
            : [];
        for (const cb of boxes) if (cb && cb.checked) picked.add(String(cb.value));
        finish(picked);
      };
      foot.appendChild(cancel);
      foot.appendChild(ok);
    }
  });
}

/* 跑一颗（含 1 次自动重试）：返回失败描述或 null */
async function superRunRunOne(st, node, seen) {
  let fail = await superRunTryNode(node, seen);
  if (fail && fail.retryable && !st.retried.has(node.id)) {
    st.retried.add(node.id);
    st.currentTitle = (node.title || node.kind || "") + I18n.t("（重试中）");
    try {
      renderCanvas();
    } catch (_) {}
    node.error = null;
    node._aborted = false;
    fail = await superRunTryNode(node, new Set());
  }
  return fail;
}
async function superRunTryNode(node, seen) {
  try {
    await runCascadeNode(node, seen);
  } catch (e) {
    /* 执行器内部的意外异常也按「这一颗失败」处理，不允许把整层挂住 */
    node.error = node.error || (e && e.message) || String(e);
  }
  return superRunFailureOf(node);
}

/* 收尾汇总（壳底部小字 / 运行队列面板都展示它；不弹 ok toast：本仓 toast 只显示 err / warn） */
function superRunSummaryText(st) {
  const bits = [];
  bits.push(superRunProgressText(st));
  if (st.skipped && st.skipped.size)
    bits.push(I18n.t("跳过 ") + st.skipped.size);
  if (st.failures && st.failures.length) {
    const names = st.failures
      .slice(0, 3)
      .map((f) => f.title || f.id)
      .join("、");
    bits.push(I18n.t("失败 ") + st.failures.length + "：" + names);
  }
  if (st.abnormal && st.abnormal.length)
    bits.push(I18n.t("渲染异常 ") + st.abnormal.length);
  return (
    I18n.t("本层") +
    (st.stopping ? I18n.t("已停止") : I18n.t("结束")) +
    " " +
    bits.join(" · ")
  );
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
    shellId: shell.id,
    done: 0,
    total: list.length,
    stopping: false,
    epoch: GLOBAL_STOP_SEQ,
    /* 还没轮到的那批（■ 停止时一次撤下它们的等待行，见 superRunStop） */
    remaining: new Set(list.map((n) => n.id)),
    orderIds: new Set(list.map((n) => n.id)),
    phase: "running",
    currentTitle: "",
    /* 正在跑的那一颗（■ 停止要按它当场中止，见 superRunAbortCurrent） */
    currentId: "",
    failed: null,
    failures: [],
    skipped: new Set(),
    retried: new Set(),
    abnormal: [],
  };
  SUPER_RUN_STATE.set(shell.id, st);
  SUPER_RUN_SUMMARY.delete(shell.id);
  const pending = new Set(list.map((n) => n.id));
  invalidateControlRunTargets(list);
  /* 先登记调度表、再挂等待态：顺序反了的话，addPendingRun 内部那一次取数就会把
     整批等待态当幽灵清掉（见 superRunScheduledRegister 的说明）。 */
  const schedReg = superRunScheduledRegister(pending);
  addPendingRun(pending);
  const seen = new Set();
  superRunPaintProgress(shell);
  superRunPaintShell(shell, true);
  let abortedBy = "";
  try {
    for (const n of list) {
      if (st.stopping) break;
      /* 期间点过「全部终止」：直接退出本层（不进暂停，见文件头的共识口径） */
      if (GLOBAL_STOP_SEQ !== st.epoch) {
        st.stopping = true;
        abortedBy = "stopall";
        break;
      }
      /* 勾选过「一并跳过」的（含其下游子树）：不启动 */
      if (st.skipped.has(n.id)) {
        st.remaining.delete(n.id);
        continue;
      }
      /* 跨画布：用户中途切走画布后 nodeById 找不到本层节点，旧写法会把剩余节点
         一个不剩地「跳过」（整层看着跑完了，实际什么都没跑）。这里连 S.wfBag 一起找，
         本层照样按原清单跑到尾。 */
      const live = superRunShellById(n.id);
      if (!live || live.running) {
        st.remaining.delete(n.id);
        continue;
      }
      st.currentTitle = live.title || live.kind || "";
      /* 正在跑的这颗：■ 停止要靠它当场中止（superRunStop → superRunAbortCurrent） */
      st.currentId = live.id;
      superRunPaintFocus(live.id, true);
      let fail = null;
      try {
        fail = await superRunRunOne(st, live, seen);
      } finally {
        st.currentId = "";
        superRunPaintFocus(live.id, false);
      }
      st.remaining.delete(live.id);
      /* 期间点过 ■（或「全部终止」）：当场退出本层。
         必须排在「失败 → 暂停」之前：被 ■ 打断的那一颗会以「已终止 / 已取消」收尾，
         那是用户自己停的，不是失败 —— 旧写法会因此进暂停、弹出「继续」，
         看起来就像停止没生效。 */
      if (st.stopping) {
        abortedBy = abortedBy || "stop";
        break;
      }
      if (!fail) {
        st.done++;
        st.currentTitle = "";
        superRunPaintProgress(shell);
        continue;
      }
      /* 失败 → 就地暂停：剩余节点不启动，等用户把这一颗跑成功再点「继续」 */
      const outcome = await superRunPauseAt(st, shell, live, fail);
      if (outcome !== "continue") {
        st.stopping = true;
        abortedBy = abortedBy || "stop";
        break;
      }
    }
  } finally {
    clearPendingRun(pending);
    superRunScheduledRestore(schedReg);
    SUPER_RUN_STATE.delete(shell.id);
    superRunPaintShell(shell, false);
    /* 收尾汇总落在壳卡片底部（左下列表那一行也随之消失）：这是「谁失败了、为何、
       跳过了几颗」的唯一常驻痕迹 —— ok toast 在本仓根本不会显示。 */
    const summary = superRunSummaryText(st);
    SUPER_RUN_SUMMARY.set(shell.id, summary);
    try {
      renderCanvas();
    } catch (_) {}
    try {
      renderStatus();
    } catch (_) {}
    try {
      updateRunQueuePanel();
    } catch (_) {}
  }
  if (st.stopping) {
    toast(
      I18n.t("已停止本层运行：完成 ") +
        Math.min(st.done, st.total) +
        "/" +
        st.total +
        (abortedBy === "stopall" ? I18n.t("（全部终止）") : ""),
      "warn",
    );
  }
  /* 顺利跑完不弹窗：本仓 toast 只显示 err / warn 两档（app.js 的 TOAST_KINDS_SHOWN），
     完成信号就是按钮从 n/N 回到 ▶、以及壳底部那行汇总小字。 */
}
