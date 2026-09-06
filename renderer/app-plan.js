"use strict";
/* ============ 复杂任务计划确认（app-plan.js） ============
 * 会话 / 智能节点执行任务时先判断任务复杂度：
 *   - 任务已非常明确（Skill 已结构化 / 用户明确要求直接执行 / 流水线节点）→ 直接执行；
 *   - 简单任务 → 直接执行；
 *   - 复杂任务 → agent 本轮不做任何改动，只输出计划 JSON（<!--MTNODE-PLAN--> 包裹）。
 * 应用解析到计划 → 提示音（复用「提问/审批提示音」）+ 可编辑任务清单确认弹窗
 * （窗口可拖拽放大 · 每条任务三列：标题 / 详情 / 模型 · 增删 / 排序 · 清单过高可滚动浏览）
 * → 确认后按清单逐项执行：每项单独一轮、用该项模型；
 * 相同 parallel 组名的任务彼此独立，异步并发执行（app 侧并发 dshRunTask，等价 subagent）。
 * 纯渲染层实现：不改 dsh 网关 / 主进程 / preload。 */

/* ---------- 计划 JSON 包裹标记（agent 输出契约） ---------- */
const PLAN_MARK_START = "<!--MTNODE-PLAN-->";
const PLAN_MARK_END = "<!--/MTNODE-PLAN-->";
const PLAN_MAX_TASKS = 8;

/* 注入到任务首条消息的「任务流程」指令（模型面向，与规划模式同口径保持中文） */
function planFlowDirective() {
  return (
    "【任务流程】先判断本任务是否已非常明确（已有具体可执行步骤 / Skill 已给出结构化流程 / 用户明确要求直接执行或「不用计划」/ 这是流水线或节点自动执行）——是，则直接执行，不要输出计划。\n" +
    "否则判断复杂度：\n" +
    "· 简单任务（改动小、目标单一明确）→ 直接执行，开头一句话说明结论即可。\n" +
    "· 复杂任务 → 本轮【禁止】任何文件 / 画布 / 命令改动，只输出一份计划：把 JSON 对象放在消息末尾，前后分别用 " +
    PLAN_MARK_START +
    " 与 " +
    PLAN_MARK_END +
    " 包裹，格式：\n" +
    '{"goal":"一句话目标","excludes":["明确不做（如：不自行测试、不改对外 API…）"],"tasks":[{"title":"任务标题","detail":"做什么 / 涉及文件 / 要点与边界（写清为什么）","model":"建议模型 id（可空=跟随默认）","parallel":"并行组名（可空；相同组名=彼此独立可并行）"}]}\n' +
    "tasks 至少 1 项、最多 " +
    PLAN_MAX_TASKS +
    " 项；按依赖顺序排列；可并行的任务给同一个 parallel 组名。\n" +
    "输出计划后立即结束本轮：不要开始实施，不要用 todo_write 登记执行清单（计划清单由应用弹窗统一管理），也不要追问「是否可以执行」——应用会弹窗请用户确认 / 编辑清单，确认后再逐项执行。"
  );
}

/* 解析计划标记文本 → { goal, excludes, tasks } | null */
function planParseFromText(text) {
  const s = String(text || "");
  const i0 = s.indexOf(PLAN_MARK_START);
  if (i0 < 0) return null;
  const i1 = s.indexOf(PLAN_MARK_END, i0 + PLAN_MARK_START.length);
  if (i1 < 0) return null;
  let raw = s.slice(i0 + PLAN_MARK_START.length, i1).trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (_) {
    const a = raw.indexOf("{");
    if (a >= 0) {
      try {
        obj = JSON.parse(raw.slice(a));
      } catch (_2) {}
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const tasks = [];
  const src = Array.isArray(obj.tasks) ? obj.tasks : [];
  for (const t of src.slice(0, PLAN_MAX_TASKS)) {
    if (!t || typeof t !== "object") continue;
    const title = String(t.title || "").trim();
    if (!title) continue;
    tasks.push({
      title,
      detail: String(t.detail || "").trim(),
      model: String(t.model || "").trim(),
      parallel: String(t.parallel || "").trim(),
    });
  }
  if (!tasks.length) return null;
  return {
    goal: String(obj.goal || "").trim(),
    excludes: Array.isArray(obj.excludes)
      ? obj.excludes
          .map((x) => String(x || ""))
          .filter(Boolean)
          .slice(0, 8)
      : [],
    tasks,
  };
}

/* ---------- 计划漏弹检测与自愈（模型偶发性生成失误） ----------
 * 现象：模型这一轮确实想交计划（正文里有计划块标记，或直接把 goal/tasks 的 JSON
 *   写了出来），但标记被写坏 / 漏了闭合 / 干脆没包 → planParseFromText 返回 null
 *   → 弹窗根本不出现，用户只看到一段"长得像计划的文字"，流程卡死在这一轮。
 * 对策：只在本轮真的被要求「按任务流程契约输出计划块」时做一次关键词检测，
 *   命中就自动回发一条纠错指令，让它照契约再生成一次（一个用户轮次最多一次，
 *   绝不无限来回；纠错轮自己不再触发自愈，只提示用户）。 */
const PLAN_FIX_MAX_ROUNDS = 1;
/* 标记串本身（容忍大小写、连字符被写成 – / — 、标记里插入空白） */
const PLAN_KEYWORD_MARK = /MTNODE[\s\-–—_]*PLAN/i;
/* 计划 JSON 的字段特征：goal 与 tasks 两个键同现（普通答复极少同时写出这两个键） */
const PLAN_KEYWORD_GOAL = /"goal"\s*:/;
const PLAN_KEYWORD_TASKS = /"tasks"\s*:/;

/* 注入的是哪一段「任务流程」指令：等于 planFlowDirective() 才算「本轮要求交计划块」。
   沿用/续跑那段明令禁止输出计划标记，那一轮不检测、不自愈。 */
function planFlowAsksForNewPlan(flowText) {
  const f = String(flowText || "").trim();
  if (!f || typeof planFlowDirective !== "function") return false;
  return f === String(planFlowDirective() || "").trim();
}

/* 该出计划却没出（漏弹）→ 返回命中的线索名（"mark" | "json"）；
   解析得到合法计划、或正文没有任何计划特征 → ""（不触发纠错） */
function planMissedDetection(text) {
  if (planParseFromText(text)) return "";
  const s = String(text || "");
  if (!s.trim()) return "";
  if (PLAN_KEYWORD_MARK.test(s)) return "mark";
  if (PLAN_KEYWORD_GOAL.test(s) && PLAN_KEYWORD_TASKS.test(s)) return "json";
  return "";
}

/* 自动纠错指令（作为一条用户消息回发给模型；与契约同口径保持中文） */
function planFixDirective() {
  return (
    "【计划未弹出 · 自动纠错】你上一轮的回复里出现了计划内容，但应用没能弹出「计划确认」弹窗" +
    "（没有解析到合法的 " +
    PLAN_MARK_START +
    " … JSON … " +
    PLAN_MARK_END +
    " 计划块）。\n" +
    "本轮唯一要做的事：把那份计划按上面「任务流程」的格式**重新完整输出一次**，要求：\n" +
    "· 两个标记一字不差（半角连字符 - · 大小写一致 · 标记内部不要插空格 / 换行 / 反引号）；\n" +
    "· 两个标记之间只放一个合法 JSON 对象：{\"goal\":\"…\",\"excludes\":[…],\"tasks\":[{\"title\":\"…\",\"detail\":\"…\",\"model\":\"\",\"parallel\":\"\"}]}，" +
    "tasks 至少 1 项、最多 " +
    PLAN_MAX_TASKS +
    " 项，字符串里的换行写成 \\n，不要有未转义的引号或尾随逗号；\n" +
    "· 不要把标记本身放进代码块，也不要只写「见上文」。\n" +
    "输出计划后立即结束本轮：不要长篇解释失误原因，不要开始实施，不要调用任何工具。"
  );
}

/* ---------- 模型分组（复用开发节点的分组函数；拿不到就空） ---------- */
function planModelGroups() {
  try {
    if (typeof devAgentModelGroups === "function") {
      const g = devAgentModelGroups();
      if (Array.isArray(g)) return g;
    }
  } catch (_) {}
  return [];
}
/* 模型 → 所属智能路由（没登记返回空串 = 跟随默认路由） */
function planRouteOfModel(model) {
  const m = String(model || "").trim();
  if (!m) return "";
  try {
    if (typeof devRouteOfModel === "function") {
      const r = devRouteOfModel(m);
      if (r) return r;
    }
  } catch (_) {}
  for (const g of planModelGroups())
    if (Array.isArray(g.models) && g.models.indexOf(m) >= 0) return g.id;
  return "";
}
/* 路由展示名（服务商名）；拿不到就退回路由 id */
function planRouteName(route) {
  const r = String(route || "").trim();
  if (!r) return "";
  try {
    if (typeof devAgentRouteName === "function") {
      const n = devAgentRouteName(r);
      if (n) return String(n);
    }
  } catch (_) {}
  return r;
}
function planDefaultProvider() {
  try {
    if (typeof defaultAgentProviderRoute === "function")
      return defaultAgentProviderRoute();
  } catch (_) {}
  return "deepseek-official";
}
/* 是否给该轮注入「任务流程」类指令（计划执行器消息 / Skill / 计划进行中 / 弹窗挂起时跳过）。
   具体注入哪一段（重新规划 / 沿用现有计划）由 planFlowInjectText 决定。 */
function planFlowInjectNeeded(st, opts, planExecMsg) {
  if (!st || planExecMsg) return false;
  if (opts && opts.planFlow === false) return false;
  if (st._planExec || st._planDlgPending) return false;
  return typeof planFlowDirective === "function";
}
/* 本轮注入的指令全文：会话里已有「确认过但还没跑完」的计划 → 注入沿用 / 续跑指令，
   而不是再逼模型规划一份新的（否则新旧计划互相覆盖、已执行项被重跑）；"" = 不注入 */
function planFlowInjectText(st, opts, planExecMsg) {
  if (!planFlowInjectNeeded(st, opts, planExecMsg)) return "";
  try {
    if (planCarryOpen(st)) return planFlowCarryDirective(st);
  } catch (_) {}
  return planFlowDirective();
}

/* ---------- 沿用现有计划（同功能块新绑定会话 / 中断后接着跑） ---------- */
/* 计划条目的简短一行（序号 + 标题 + 截断详情）：注入指令与新会话首轮上下文共用 */
function planBriefLines(steps, limit, detailMax, withStatus) {
  const arr = (Array.isArray(steps) ? steps : []).filter(Boolean);
  const cap = limit || 12;
  const dm = detailMax || 120;
  const out = [];
  arr.slice(0, cap).forEach((s, i) => {
    const d = String(s.detail || "").replace(/\s+/g, " ").trim();
    const cut = d.length > dm ? d.slice(0, dm) + "…" : d;
    out.push(
      "  " +
        (withStatus && s.status
          ? "[" + (PLAN_STEP_ICON[planStepStatus(s.status)] || "") + "] "
          : "") +
        (Number(s.n) || i + 1) +
        ". " +
        String(s.title || "").trim() +
        (cut ? "：" + cut : ""),
    );
  });
  if (arr.length > cap)
    out.push("  …（另有 " + (arr.length - cap) + " 项，见会话「计划」面板）");
  return out;
}
/* 本会话是否有一份「确认过但还没跑完」且归属正确的计划 */
function planCarryOpen(st) {
  if (!st || !st.plan) return false;
  try {
    if (typeof planOwnedHere === "function" && !planOwnedHere(st)) return false;
    return typeof planHasOpen === "function" ? planHasOpen(st) : false;
  } catch (_) {
    return false;
  }
}
/* 「沿用 / 续跑现有计划」指令（替代重新规划指令） */
function planFlowCarryDirective(st) {
  const p = (st && st.plan) || {};
  const steps = Array.isArray(p.steps) ? p.steps.filter(Boolean) : [];
  const open = steps.filter(
    (s) => s.status !== "done" && s.status !== "skipped",
  );
  const fin = steps.filter(
    (s) => s.status === "done" || s.status === "skipped",
  );
  let lines = ["【任务流程 · 沿用现有计划】"];
  if (String(p.goal || "").trim())
    lines.push("目标：" + String(p.goal).trim().slice(0, PLAN_GOAL_MAX));
  lines.push(
    "本会话已有一份经用户确认、尚未执行完的计划（已完成 " +
      (steps.length - open.length) +
      "/" +
      steps.length +
      "），本轮以这份既有清单为准：",
  );
  lines.push("未完成（本轮要做的）：");
  lines = lines.concat(planBriefLines(open, PLAN_MAX_TASKS, 140, true));
  if (fin.length) {
    lines.push("已完成（禁止重做）：");
    lines = lines.concat(planBriefLines(fin, PLAN_MAX_TASKS, 60, true));
  }
  lines.push(
    "要求：按上述未完成项继续推进；【禁止】再输出一份新计划，也禁止出现 " +
      PLAN_MARK_START +
      " / " +
      PLAN_MARK_END +
      " 计划标记；不要重新拆分、改名或替换既有任务。若你判断范围确实需要调整，只在正文里用一句话说明理由，" +
      "由用户在「计划」面板上决定续跑还是清除。做完后逐项简要汇报结果。",
  );
  return lines.join("\n");
}
/* 跨会话计划沿用已整体移除（计划只属于发起它的会话）：
   不再有「复制上一会话计划 + 重贴归属」的入口 —— 新绑定会话一律干净上下文，
   旧计划只能由它自己的会话面板 ▶ 续跑；此位置不再保留死代码防止回归复活。 */

/* 单轮任务消息（发给模型的执行指令） */
function planTaskMessage(task, i, n, parallel) {
  const head = parallel
    ? I18n.t("【执行已确认计划 · 并行任务】")
    : I18n.t("【执行已确认计划 · 任务 ") + (i || 1) + "/" + (n || 1) + I18n.t("】");
  return (
    head +
    "\n" +
    String(task.title || "").trim() +
    (String(task.detail || "").trim() ? "\n" + String(task.detail).trim() : "") +
    "\n\n严格只做本任务列出的内容，禁止做计划外的事（不要自行运行测试、构建、安装依赖、重构无关代码，除非任务里明确要求）。完成本任务后只汇报本任务的改动与结果。"
  );
}

/* ---------- 对话框小工具（复用 #mtDialog 深色宿主） ---------- */
function planDlgEl(tag, cls, txt) {
  const el = document.createElement(tag || "div");
  if (cls) el.className = cls;
  if (txt != null) el.textContent = String(txt);
  return el;
}
function planDlgBtn(a) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = a.primary ? "mini primary" : a.danger ? "mini danger" : "mini";
  b.textContent = a.label || a.id;
  if (a.title) b.title = a.title;
  b.onclick = () => a.run();
  return b;
}
function planRemove(el) {
  try {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  } catch (_) {}
}

/* ---------- 窗口尺寸：右下角可拖拽放大（本次会话记住）· ⤢ 最大化 · 双击手柄还原 ----------
 * 弹窗宿主 .mt-dialog 居中摆放，所以向右下拖 1px，宽高各 +2px，手柄始终跟手。 */
const PLAN_BOX_MIN_W = 660;
const PLAN_BOX_MIN_H = 400;
/* 宿主 .mt-dialog 自带 24px 内边距，留 56px 才不会把窗口顶出可视区 */
const PLAN_BOX_EDGE = 56;
let _planBoxSize = null; /* 用户拖出来的尺寸 { w, h }；null = 用 CSS 默认 */
let _planBoxPreMax = null; /* 最大化之前的尺寸，供「还原」用 */
let _planBoxMaxed = false;

function planViewport() {
  const w =
    (typeof window !== "undefined" && window && window.innerWidth) || 1600;
  const h =
    (typeof window !== "undefined" && window && window.innerHeight) || 900;
  return { w, h };
}
function planBoxRect(box) {
  try {
    if (box && typeof box.getBoundingClientRect === "function") {
      const r = box.getBoundingClientRect();
      if (r && r.width && r.height) return r;
    }
  } catch (_) {}
  return { width: PLAN_BOX_MIN_W, height: PLAN_BOX_MIN_H };
}
/* 设尺寸（夹在最小值与视口之间），返回真正生效的尺寸 */
function planBoxSetSize(box, w, h) {
  const vp = planViewport();
  const cw = Math.round(
    Math.min(
      Math.max(w, PLAN_BOX_MIN_W),
      Math.max(PLAN_BOX_MIN_W, vp.w - PLAN_BOX_EDGE),
    ),
  );
  const ch = Math.round(
    Math.min(
      Math.max(h, PLAN_BOX_MIN_H),
      Math.max(PLAN_BOX_MIN_H, vp.h - PLAN_BOX_EDGE),
    ),
  );
  box.style.width = cw + "px";
  box.style.height = ch + "px";
  box.style.maxHeight = "none";
  return { w: cw, h: ch };
}
function planBoxRestore(box) {
  box.style.width = "";
  box.style.height = "";
  box.style.maxHeight = "";
  _planBoxSize = null;
  _planBoxPreMax = null;
  _planBoxMaxed = false;
}
/* 打开弹窗时套用上次尺寸 */
function planBoxApply(box) {
  if (_planBoxSize) planBoxSetSize(box, _planBoxSize.w, _planBoxSize.h);
  else planBoxRestore(box);
}
/* 装上「最大化按钮 + 拖拽手柄」；返回卸载函数 */
function planBoxResizer(box) {
  let maxBtn = null;
  const syncMax = () => {
    if (!maxBtn) return;
    maxBtn.textContent = _planBoxMaxed ? "⤡" : "⤢";
    maxBtn.title = _planBoxMaxed
      ? I18n.t("还原窗口大小")
      : I18n.t("最大化窗口（也可拖右下角自由放大）");
  };
  const toggleMax = () => {
    if (_planBoxMaxed) {
      /* 回到最大化之前的尺寸（用户拖出来的那个，没拖过就回到 CSS 默认） */
      const back = _planBoxPreMax || _planBoxSize;
      _planBoxMaxed = false;
      _planBoxPreMax = null;
      if (back) {
        _planBoxSize = planBoxSetSize(box, back.w, back.h);
      } else {
        planBoxRestore(box);
      }
    } else {
      const vp = planViewport();
      _planBoxPreMax = _planBoxSize ? { w: _planBoxSize.w, h: _planBoxSize.h } : null;
      _planBoxSize = planBoxSetSize(
        box,
        vp.w - PLAN_BOX_EDGE,
        vp.h - PLAN_BOX_EDGE,
      );
      _planBoxMaxed = true;
    }
    syncMax();
  };
  const head = box.querySelector(".mt-dialog-head");
  if (head) {
    maxBtn = planDlgBtn({
      label: "⤢",
      title: I18n.t("最大化窗口（也可拖右下角自由放大）"),
      run: toggleMax,
    });
    maxBtn.className = "mini mt-plan-max";
    head.appendChild(maxBtn);
  }

  let onMove = null;
  let onUp = null;
  const stopDrag = () => {
    if (onMove) {
      document.removeEventListener("pointermove", onMove, true);
      onMove = null;
    }
    if (onUp) {
      document.removeEventListener("pointerup", onUp, true);
      onUp = null;
    }
    try {
      document.body.classList.remove("plan-resizing");
    } catch (_) {}
  };
  const grip = planDlgEl("div", "mt-plan-resize");
  grip.title = I18n.t("拖拽放大 / 缩小窗口 · 双击还原默认大小");
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const r = planBoxRect(box);
    const sx = ev.clientX || 0;
    const sy = ev.clientY || 0;
    const sw = r.width;
    const sh = r.height;
    onMove = (e) => {
      _planBoxSize = planBoxSetSize(
        box,
        sw + ((e.clientX || 0) - sx) * 2,
        sh + ((e.clientY || 0) - sy) * 2,
      );
      _planBoxMaxed = false;
      syncMax();
    };
    onUp = () => {
      stopDrag();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    try {
      document.body.classList.add("plan-resizing");
    } catch (_) {}
  });
  grip.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    planBoxRestore(box);
    syncMax();
  });
  box.appendChild(grip);
  syncMax();
  return () => {
    stopDrag();
    planRemove(maxBtn);
    planRemove(grip);
  };
}

/* ---------- 逐项模型：一个按钮 + 点击弹出下拉菜单（按服务商分组，可滚动） ---------- */
let _planModelPool = []; /* 本次弹窗的可选模型分组 */
let _planModelRow = null; /* 正在改模型的那一行 */
let _planModelAnchor = null;
let _planModelOutside = null; /* document 级「点外面关闭」监听 */

function planModelPopOpen() {
  const el = document.getElementById("planModelPop");
  return !!(el && el.classList.contains("on"));
}
function planModelKnown(model) {
  const m = String(model || "").trim();
  if (!m) return true;
  for (const g of _planModelPool || [])
    if (Array.isArray(g.models) && g.models.map(String).indexOf(m) >= 0)
      return true;
  return false;
}
function planModelText(row) {
  const m = String((row && row.model) || "").trim();
  return m || I18n.t("自动（跟随默认）");
}
function planModelTip(row) {
  const m = String((row && row.model) || "").trim();
  if (!m)
    return I18n.t("模型：自动（跟随默认）· 点击为本任务单独选择");
  const r = planRouteOfModel(m);
  return (
    I18n.t("模型：") +
    m +
    (r ? " · " + planRouteName(r) : "") +
    I18n.t(" · 点击修改（本任务单独用它执行）")
  );
}
function planModelPopEl() {
  let el = document.getElementById("planModelPop");
  if (el) return el;
  el = document.createElement("div");
  el.id = "planModelPop";
  el.className = "mt-plan-model-pop";
  const head = planDlgEl("div", "mt-plan-model-head");
  head.appendChild(planDlgEl("b", null, I18n.t("本任务的执行模型")));
  const close = planDlgBtn({
    label: "✕",
    title: I18n.t("关闭"),
    run: () => closePlanModelPicker(),
  });
  close.className = "mini mt-plan-model-close";
  head.appendChild(close);
  const list = planDlgEl("div", "mt-plan-model-list");
  const foot = planDlgEl("div", "mt-plan-model-actions");
  const reset = planDlgBtn({
    label: I18n.t("跟随默认（不指定）"),
    run: () => applyPlanModelChoice(""),
  });
  reset.className = "mini mt-plan-model-reset";
  foot.appendChild(reset);
  el.appendChild(head);
  el.appendChild(list);
  el.appendChild(foot);
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closePlanModelPicker();
    }
  });
  document.body.appendChild(el);
  return el;
}
function planModelOptBtn(model, on) {
  const b = planDlgEl("button", "mt-plan-model-opt" + (on ? " on" : ""));
  b.type = "button";
  b.appendChild(planDlgEl("span", "m", model));
  b.appendChild(planDlgEl("span", "c", on ? "✓" : ""));
  b.onclick = () => applyPlanModelChoice(model);
  return b;
}
function renderPlanModelPop() {
  const el = document.getElementById("planModelPop");
  if (!el || !_planModelRow) return;
  const list = el.querySelector(".mt-plan-model-list");
  if (!list) return;
  list.innerHTML = "";
  const cur = String(_planModelRow.model || "");
  let any = 0;
  if (cur && !planModelKnown(cur)) {
    list.appendChild(
      planDlgEl("div", "mt-plan-model-group", I18n.t("模型建议（未登记在模型服务）")),
    );
    list.appendChild(planModelOptBtn(cur, true));
    any++;
  }
  for (const g of _planModelPool || []) {
    const models = Array.isArray(g.models) ? g.models : [];
    if (!models.length) continue;
    list.appendChild(
      planDlgEl("div", "mt-plan-model-group", g.name || g.id || ""),
    );
    for (const m of models) {
      list.appendChild(planModelOptBtn(String(m), String(m) === cur));
      any++;
    }
  }
  if (!any)
    list.appendChild(
      planDlgEl(
        "div",
        "mt-plan-model-empty",
        I18n.t("暂无可用模型：请先在 设置 → 模型服务 中添加服务商与模型。"),
      ),
    );
}
function openPlanModelPop(row, anchor) {
  _planModelRow = row;
  _planModelAnchor = anchor;
  const el = planModelPopEl();
  el.classList.add("on");
  renderPlanModelPop();
  const r = planBoxRect(anchor);
  const rect =
    (typeof anchor.getBoundingClientRect === "function"
      ? anchor.getBoundingClientRect()
      : null) || r;
  const vp = planViewport();
  const pad = 8;
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 320;
  let left = rect.left != null ? rect.left : 0;
  let top = (rect.bottom != null ? rect.bottom : 0) + 6;
  if (left + w > vp.w - pad) left = vp.w - w - pad;
  if (left < pad) left = pad;
  if (top + h > vp.h - pad) top = Math.max(pad, (rect.top || 0) - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
  if (anchor.classList) anchor.classList.add("on");
  if (!_planModelOutside) {
    _planModelOutside = (ev) => {
      const p = document.getElementById("planModelPop");
      if (!p || !p.classList.contains("on")) return;
      if (p === ev.target || (p.contains && p.contains(ev.target))) return;
      if (_planModelAnchor && _planModelAnchor.contains && _planModelAnchor.contains(ev.target))
        return;
      closePlanModelPicker();
    };
    document.addEventListener("pointerdown", _planModelOutside, true);
  }
}
function closePlanModelPicker() {
  _planModelRow = null;
  if (_planModelAnchor && _planModelAnchor.classList)
    _planModelAnchor.classList.remove("on");
  _planModelAnchor = null;
  const el = document.getElementById("planModelPop");
  if (el) el.classList.remove("on");
  if (_planModelOutside) {
    document.removeEventListener("pointerdown", _planModelOutside, true);
    _planModelOutside = null;
  }
}
function togglePlanModelPop(row, anchor) {
  if (planModelPopOpen() && _planModelAnchor === anchor) {
    closePlanModelPicker();
    return;
  }
  closePlanModelPicker();
  openPlanModelPop(row, anchor);
}
function applyPlanModelChoice(model) {
  const row = _planModelRow;
  const btn = _planModelAnchor;
  const m = String(model || "").trim();
  if (row) row.model = m;
  closePlanModelPicker();
  if (btn) planModelButtonRefresh(btn, row || { model: m });
}
function planModelButtonRefresh(btn, row) {
  const lbl = btn.querySelector(".lbl");
  if (lbl) lbl.textContent = planModelText(row);
  btn.className =
    "mini mt-plan-model" + (String((row && row.model) || "").trim() ? " picked" : " auto");
  btn.title = planModelTip(row);
}
function planModelButton(row) {
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "mini mt-plan-model" + (String(row.model || "").trim() ? " picked" : " auto");
  b.appendChild(planDlgEl("span", "lbl", planModelText(row)));
  b.appendChild(planDlgEl("span", "chev", "▾"));
  b.title = planModelTip(row);
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    togglePlanModelPop(row, b);
  };
  return b;
}

/* ---------- 计划确认弹窗：提示音 + 可拉伸窗口 + 三列可编辑任务清单 ----------
 * prev = 该会话此前已确认的那份计划（同功能块时来自上一次绑定会话）：
 *   仍有未完成项 → 原样预填进清单顶部（可就地增删改 · 已完成项标 ✓ 不重跑）；
 *   全部完成   → 不预填（否则会被当成本轮待办重跑），只作「已完成参考」显示。 */
/* 上一份计划里仍待执行的项 → 预填行（保持原顺序与状态；含已完成项，仅标出来不重跑） */
function planCarryRows(prev) {
  const steps =
    prev && Array.isArray(prev.steps) ? prev.steps.filter(Boolean) : [];
  if (!steps.length) return [];
  const open = steps.filter(
    (s) => s.status !== "done" && s.status !== "skipped",
  );
  if (!open.length) return [];
  return steps.map((s) => ({
    title: String(s.title || ""),
    detail: String(s.detail || ""),
    model: String(s.model || ""),
    parallel: String(s.parallel || ""),
    status: planStepStatus(s.status),
    carry: true,
  }));
}
/* 上一份计划里已经了结的项（done / skipped）：弹窗内只读展示，不参与执行 */
function planRefRows(prev) {
  const steps =
    prev && Array.isArray(prev.steps) ? prev.steps.filter(Boolean) : [];
  return steps.filter((s) => s.status === "done" || s.status === "skipped");
}
function planConfirmDialog(owner, plan, prev) {
  return new Promise((resolve) => {
    try {
      if (typeof playIxSound === "function") playIxSound();
    } catch (_) {}
    const host = ensureMtDialog();
    const box = host.querySelector(".mt-dialog-box");
    if (box) {
      box.classList.add("mt-form-box");
      box.classList.add("mt-form-wide");
      box.classList.add("mt-plan-box");
    }
    const titleEl = document.getElementById("mtDlgTitle");
    const bodyEl = document.getElementById("mtDlgBody");
    const footEl = document.getElementById("mtDlgFoot");
    const goal = String(plan.goal || "").trim();
    /* 标题标明这条计划归属谁（多会话 / 多功能块并行时不会认错） */
    const ownerLbl = planOwnerLabel(owner);
    if (titleEl)
      titleEl.textContent =
        I18n.t("计划确认") +
        (ownerLbl ? " · " + ownerLbl : "") +
        (goal ? " · " + goal.slice(0, 44) : "");
    const groups = planModelGroups();
    _planModelPool = groups;
    /* 先放沿用项（上次确认过的清单，已 done 的原样带状态），再接本次新提的任务；
       标题同名视为同一项，不重复列出（沿用项优先，保住它已执行过的状态） */
    const normTitle = (s) =>
      String(s || "").replace(/\s+/g, "").trim().toLowerCase();
    const carry = planCarryRows(prev);
    const rows = carry.slice();
    const seen = new Set(rows.map((r) => normTitle(r.title)).filter(Boolean));
    for (const t of plan.tasks || []) {
      const k = normTitle(t.title);
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      rows.push({
        title: String(t.title || ""),
        detail: String(t.detail || ""),
        model: String(t.model || ""),
        parallel: String(t.parallel || ""),
        status: "pending",
        carry: false,
      });
    }
    /* 全部完成的那份计划只作参考：列在预填行之外的已了结条目 */
    const refRows = planRefRows(prev).filter(
      (s) => !rows.some((r) => normTitle(r.title) === normTitle(s.title)),
    );
    const carryOpen = carry.filter(
      (r) => r.status !== "done" && r.status !== "skipped",
    ).length;
    const carryFin = carry.length - carryOpen;
    let done = false;
    const detachResizer = box ? planBoxResizer(box) : null;
    if (box) planBoxApply(box);
    const cleanup = () => {
      host.removeEventListener("keydown", onKey);
      closePlanModelPicker();
      try {
        if (detachResizer) detachResizer();
      } catch (_) {}
      closeMtDialog();
      if (box) {
        box.classList.remove("mt-form-box");
        box.classList.remove("mt-form-wide");
        box.classList.remove("mt-plan-box");
        box.style.width = "";
        box.style.height = "";
        box.style.maxHeight = "";
      }
      _planModelPool = [];
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };
    const frag = document.createDocumentFragment();
    /* 标题容易被截断，正文再明确一次：合为一块——标题 = 这条计划属于谁（执行位置），
       内容 = 一句话目标。归属提示（会话删除即作废）不再占用弹窗空间。 */
    if (ownerLbl || goal) {
      const nb = planDlgEl("div", "mt-form-note");
      nb.appendChild(planDlgEl("i", null, ownerLbl || I18n.t("目标")));
      nb.appendChild(planDlgEl("p", null, goal || ownerLbl));
      frag.appendChild(nb);
    }
    /* 计划 JSON 里的 excludes 仍照旧解析 / 落盘（供下游与面板追溯），只是确认弹窗不再单列 */
    if (carryOpen) {
      const nb = planDlgEl("div", "mt-form-note");
      nb.appendChild(planDlgEl("i", null, I18n.t("沿用上次计划")));
      nb.appendChild(
        planDlgEl(
          "p",
          null,
          I18n.t("上一次确认的清单里还有 ") +
            carryOpen +
            I18n.t(" 项未完成，已原样预填在下方（可就地增删改）") +
            (carryFin
              ? I18n.t("；已完成的 ") +
                carryFin +
                I18n.t(" 项保留作记录，不会再跑一遍")
              : "") +
            "。",
        ),
      );
      frag.appendChild(nb);
    } else if (refRows.length) {
      const lb = planDlgEl("div", "mt-form-list");
      lb.appendChild(
        planDlgEl(
          "i",
          null,
          I18n.t("已完成参考（上一次计划 · 不会自动续跑）"),
        ),
      );
      const ul = planDlgEl("div");
      for (const s of refRows)
        ul.appendChild(
          planDlgEl("span", "mt-form-li", "✓ " + String(s.title || "")),
        );
      lb.appendChild(ul);
      frag.appendChild(lb);
    }
    frag.appendChild(
      planDlgEl(
        "label",
        "mt-form-lab",
        I18n.t("任务清单（可编辑 · 增删 / 排序 / 逐项指定模型）"),
      ),
    );
    const listWrap = planDlgEl("div", "mt-plan-rows");
    const emptyP = planDlgEl("p", "mt-form-err", I18n.t("至少保留一个任务"));
    emptyP.hidden = true;
    frag.appendChild(listWrap);
    frag.appendChild(emptyP);

    /* 多行输入：随内容自动长高（用户手动拖过就不再抢），长文可读 */
    function makeArea(cls, key, row, ph, minRows, maxPx) {
      const ta = document.createElement("textarea");
      ta.className = "mt-plan-inp " + cls;
      ta.placeholder = ph;
      ta.value = String(row[key] || "");
      ta.rows = minRows;
      ta.title = ta.value || ph;
      let manual = false;
      const grow = () => {
        if (manual) return;
        try {
          ta.style.height = "auto";
          const natural = (ta.scrollHeight || 0) + 2;
          const minPx = minRows * 20 + 14;
          ta.style.height =
            Math.max(minPx, Math.min(natural || minPx, maxPx)) + "px";
        } catch (_) {}
      };
      grow(); /* 先给一个不塌陷的初始高度，挂进 DOM 后再按真实内容精修 */
      ta.addEventListener("input", () => {
        row[key] = ta.value;
        ta.title = ta.value;
        if (key === "title") emptyP.hidden = true;
        grow();
      });
      ta.addEventListener("focus", grow);
      ta.addEventListener("pointerup", (ev) => {
        /* 下缘 6px 内抬起 = 用户自己拉高了本框，之后不再自动改高 */
        try {
          const r =
            typeof ta.getBoundingClientRect === "function"
              ? ta.getBoundingClientRect()
              : null;
          if (r && ev.clientY >= r.bottom - 6) manual = true;
        } catch (_) {}
      });
      setTimeout(grow, 0);
      return ta;
    }

    function renderRows() {
      closePlanModelPicker();
      listWrap.innerHTML = "";
      const colHead = planDlgEl("div", "mt-plan-cols mt-plan-colhead");
      colHead.appendChild(planDlgEl("span", null, I18n.t("任务标题")));
      colHead.appendChild(planDlgEl("span", null, I18n.t("详情 / 涉及文件 / 边界")));
      colHead.appendChild(planDlgEl("span", "mt-plan-col-model", I18n.t("执行模型")));
      listWrap.appendChild(colHead);
      rows.forEach((row, idx) => {
        const card = planDlgEl("div", "mt-plan-card");
        const hd = planDlgEl("div", "mt-plan-card-head");
        hd.appendChild(planDlgEl("span", "mt-plan-idx", String(idx + 1)));
        if (row.carry)
          hd.appendChild(
            planDlgEl(
              "span",
              "mt-plan-carry" +
                (row.status === "done" || row.status === "skipped"
                  ? " fin"
                  : ""),
              row.status === "done"
                ? "✓ " + I18n.t("已完成（沿用 · 不重跑）")
                : row.status === "skipped"
                  ? "⊘ " + I18n.t("已跳过（沿用）")
                  : "↪ " + I18n.t("沿用上次计划"),
            ),
          );
        hd.appendChild(planDlgEl("span", "mt-plan-para-lab", I18n.t("并行组")));
        const pg = document.createElement("input");
        pg.type = "text";
        pg.className = "mt-plan-para";
        pg.placeholder = I18n.t("同组名的任务并发执行（留空 = 按顺序单独跑）");
        pg.title = I18n.t(
          "并行组名：填相同名字的若干任务会同时异步执行；留空则按清单顺序一项一项跑。",
        );
        pg.value = row.parallel;
        pg.addEventListener("input", () => {
          row.parallel = pg.value;
        });
        hd.appendChild(pg);
        hd.appendChild(planDlgEl("span", "mt-plan-head-spacer"));
        const up = planDlgBtn({
          label: "↑",
          title: I18n.t("上移"),
          run: () => {
            if (idx > 0) {
              const t = rows[idx - 1];
              rows[idx - 1] = rows[idx];
              rows[idx] = t;
              renderRows();
            }
          },
        });
        const dn = planDlgBtn({
          label: "↓",
          title: I18n.t("下移"),
          run: () => {
            if (idx < rows.length - 1) {
              const t = rows[idx + 1];
              rows[idx + 1] = rows[idx];
              rows[idx] = t;
              renderRows();
            }
          },
        });
        const del = planDlgBtn({
          label: "✕",
          title: I18n.t("删除该项"),
          run: () => {
            rows.splice(idx, 1);
            renderRows();
          },
        });
        up.className = "mini mt-plan-mv";
        dn.className = "mini mt-plan-mv";
        del.className = "mini danger mt-plan-del";
        hd.appendChild(up);
        hd.appendChild(dn);
        hd.appendChild(del);
        const cols = planDlgEl("div", "mt-plan-cols");
        cols.appendChild(
          makeArea("title", "title", row, I18n.t("任务标题"), 2, 160),
        );
        cols.appendChild(
          makeArea(
            "detail",
            "detail",
            row,
            I18n.t("详情（做什么 / 涉及文件 / 要点与边界）"),
            3,
            300,
          ),
        );
        const colM = planDlgEl("div", "mt-plan-col-model");
        colM.appendChild(planModelButton(row));
        cols.appendChild(colM);
        card.appendChild(hd);
        card.appendChild(cols);
        listWrap.appendChild(card);
      });
    }
    renderRows();
    const addBtn = planDlgBtn({
      label: "＋ " + I18n.t("添加任务"),
      run: () => {
        if (rows.length >= PLAN_MAX_TASKS) {
          try {
            toast(
              I18n.t("最多 ") + PLAN_MAX_TASKS + I18n.t(" 项任务"),
              "warn",
            );
          } catch (_) {}
          return;
        }
        rows.push({ title: "", detail: "", model: "", parallel: "" });
        renderRows();
        try {
          const all = listWrap.querySelectorAll(".mt-plan-card");
          const last = all[all.length - 1];
          if (last && last.querySelector) {
            const f = last.querySelector(".mt-plan-inp");
            if (f) f.focus();
            if (last.scrollIntoView) last.scrollIntoView(false);
          }
        } catch (_) {}
      },
    });
    addBtn.className = "mini mt-plan-add";
    frag.appendChild(addBtn);
    frag.appendChild(
      planDlgEl(
        "p",
        "mt-form-hint",
        I18n.t(
          "拖右下角可放大窗口（双击还原 · ⤢ 最大化）· 清单过高时框内滚动浏览 · 标题与详情为多行输入，随内容长高 · 点「执行模型」按钮为该任务单独选模型 · 确认后按清单逐项执行（同组并行任务并发跑）· Ctrl+Enter 确认 · Esc 取消",
        ),
      ),
    );
    if (bodyEl) {
      bodyEl.innerHTML = "";
      bodyEl.appendChild(frag);
    }
    if (footEl) {
      footEl.innerHTML = "";
      footEl.appendChild(
        planDlgBtn({ label: I18n.t("取消"), run: () => finish({ action: "cancel" }) }),
      );
      footEl.appendChild(
        planDlgBtn({
          label: I18n.t("确认执行"),
          primary: true,
          title: I18n.t("按清单逐项执行（顺序 / 内容 / 模型以当前编辑结果为准）"),
          run: () => {
            const out = rows
              .map((r) => ({
                title: String(r.title || "").trim(),
                detail: String(r.detail || "").trim(),
                model: String(r.model || "").trim(),
                parallel: String(r.parallel || "").trim(),
                /* 沿用项带着原状态回来：已 done 的仍标 done，执行器只跑未完成项 */
                status: r.status || "pending",
              }))
              .filter((t) => t.title);
            if (!out.length) {
              emptyP.hidden = false;
              return;
            }
            finish({ action: "go", tasks: out });
          },
        }),
      );
    }
    host.classList.add("on");
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        /* 模型下拉开着时：Esc 只收下拉，不关整个弹窗 */
        if (planModelPopOpen()) {
          ev.preventDefault();
          ev.stopPropagation();
          closePlanModelPicker();
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        finish({ action: "cancel" });
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        const b = footEl && footEl.querySelector(".primary");
        if (b) b.click();
      }
    };
    host.addEventListener("keydown", onKey);
    try {
      const f = bodyEl && bodyEl.querySelector(".mt-plan-inp");
      if (f) f.focus();
    } catch (_) {}
  });
}

/* ---------- 执行步骤规划：串行 + 并行组 ---------- */
function planBuildSteps(tasks) {
  const steps = [];
  const byName = new Map();
  tasks.forEach((t) => {
    const g = String(t.parallel || "").trim();
    if (g) {
      if (!byName.has(g)) byName.set(g, []);
      byName.get(g).push(t);
    }
  });
  const emitted = new Set();
  for (const t of tasks) {
    const g = String(t.parallel || "").trim();
    if (g) {
      if (!emitted.has(g)) {
        emitted.add(g);
        const arr = byName.get(g);
        steps.push(arr.length >= 2 ? { kind: "par", tasks: arr } : { kind: "seq", task: arr[0] });
      }
    } else {
      steps.push({ kind: "seq", task: t });
    }
  }
  return steps;
}

/* app 侧并发 dshRunTask（异步并行子任务，等价 subagent；各自独立上下文与模型） */
/* opts.onEvent：把 reasoning / text / tool / tool-result / usage / error 事件透出来，
   否则并行组跑起来全程静默（计划面板里只有一个静态「◐ 执行中」）。
   opts.runKey：必须可预测（见 planParRunKey），随机 uid 会让外部无人持有句柄 →
   既取消不了也记不了账；缺省才退回随机键（兼容老调用点）。
   opts.canvasWfId：发起它的会话「所属画布」。子任务不另起归属：它就该落在 owner 会话
   那张图上（用户此刻看到的可能是另一张画布）；没显式给时宿主按 runKey 反查同一归属。 */
function planDshRunOnce(input, opts) {
  opts = opts || {};
  return dshRunTask(input, {
    runKey: String(opts.runKey || "planpar:" + uid("p")),
    canvasWfId: String(opts.canvasWfId || ""),
    workspace: opts.workspace,
    preset: opts.preset,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    onEvent: typeof opts.onEvent === "function" ? opts.onEvent : undefined,
    systemPrompt:
      "回答简洁。你是异步并行子任务（subagent），只做本任务并用工作区文件交付结果，不要做计划外的事。",
    onDone: (d) => {
      try {
        if (typeof recordDshMetrics === "function") recordDshMetrics(null, d.metrics);
      } catch (_) {}
    },
  });
}

/* ---------- 并行子任务的实时观测缓冲 ----------
 * 并行任务既不走会话流式通道（agentSessionSend），也没有宿主 node，
 * 所以网关事件原本全被丢弃。这里给每个在跑的计划步骤挂一份运行时轨迹
 * t._live（正文/思考尾部 + 工具调用列表 + token 累计 + 状态），
 * 计划面板（live 转写区）与左下角运行队列都只读这一份数据形状。
 * 落盘安全：会话持久化按 planSanitize 白名单重建步骤对象（app-assist.js:944），
 * 下划线运行时字段一律被剔除；收尾再在 finally 里主动摘除，不留幽灵轨迹。 */
const PLAN_LIVE_TEXT_MAX = 6000; /* 正文 / 思考各保留尾部这么多字符 */
const PLAN_LIVE_TOOLS_MAX = 80; /* 工具调用最多记 80 条（溢出丢最旧） */
const PLAN_LIVE_ARG_MAX = 220;
const PLAN_LIVE_RES_MAX = 220;
const PLAN_LIVE_ERR_MAX = 6;
const PLAN_LIVE_RENDER_MS = 250; /* 事件 → 面板刷新的 trailing 节流窗口 */

/* 可预测的取消/记账键：planpar:<会话或节点id>:<步骤序号> */
function planParRunKey(ownerId, t, k) {
  return (
    "planpar:" + String((ownerId && String(ownerId)) || "x") + ":" + ((t && t.n) || k + 1)
  );
}

function planLiveInit() {
  const now = Date.now();
  return {
    startedAt: now,
    lastAt: now,
    state: "running", /* running | done | error | cancelled */
    text: "", /* 正文尾部（并行子任务的实际产出） */
    reasoning: "", /* 思考尾部 */
    chars: 0, /* 累计输出字符数（不截断，UI 直接用） */
    toolCalls: 0,
    lastTool: "",
    tools: [], /* [{callId,name,args,state,result,error,since,at}] */
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    errors: [],
  };
}

function planLiveTail(cur, add, max) {
  const s = String(cur || "") + String(add || "");
  return s.length > max ? s.slice(s.length - max) : s;
}

/* 工具结果可能是字符串 / 内容块数组 / 对象：压成一行摘要，不整包留在内存里 */
function planLiveToolSummary(content) {
  let s = "";
  try {
    if (content == null) s = "";
    else if (Array.isArray(content))
      s = content
        .map((x) =>
          typeof x === "string"
            ? x
            : String((x && (x.text || x.content || x.type)) || "").trim(),
        )
        .filter(Boolean)
        .join(" ");
    else if (typeof content === "object") s = JSON.stringify(content);
    else s = String(content);
  } catch (_) {
    s = "";
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > PLAN_LIVE_RES_MAX ? s.slice(0, PLAN_LIVE_RES_MAX) + "…" : s;
}

/* 把一次网关事件并进 live 缓冲；返回是否有实质变化（供调用方决定刷新） */
function planLiveFeed(live, type, data) {
  if (!live || typeof live !== "object") return false;
  data = data || {};
  const now = Date.now();
  try {
    if (type === "text" && data.text) {
      live.text = planLiveTail(live.text, data.text, PLAN_LIVE_TEXT_MAX);
      live.chars += String(data.text).length;
    } else if (type === "reasoning" && data.text) {
      live.reasoning = planLiveTail(live.reasoning, data.text, PLAN_LIVE_TEXT_MAX);
    } else if (type === "tool" && data.name) {
      const args = String(data.args || "");
      live.tools.push({
        callId: data.callId,
        turn: data.turn,
        step: data.step,
        name: String(data.name),
        args: args.length > PLAN_LIVE_ARG_MAX ? args.slice(0, PLAN_LIVE_ARG_MAX) + "…" : args,
        state: "running",
        result: "",
        error: null,
        since: now,
        at: now,
      });
      if (live.tools.length > PLAN_LIVE_TOOLS_MAX)
        live.tools.splice(0, live.tools.length - PLAN_LIVE_TOOLS_MAX);
      live.toolCalls++;
      live.lastTool = String(data.name);
    } else if (type === "tool-result" && data.callId) {
      const t = live.tools.find((x) => x && x.callId === data.callId);
      if (t) {
        t.state = data.error ? "error" : "done";
        t.result = planLiveToolSummary(data.content);
        t.error = data.error ? String(data.error).slice(0, PLAN_LIVE_RES_MAX) : null;
        t.at = now;
      }
    } else if (type === "usage") {
      live.usage.inputTokens += Number(data.inputTokens) || 0;
      live.usage.outputTokens += Number(data.outputTokens) || 0;
      live.usage.cacheReadTokens += Number(data.cacheReadTokens) || 0;
      live.usage.reasoningTokens += Number(data.reasoningTokens) || 0;
    } else if (type === "error" && data.message) {
      live.errors.push(String(data.message).slice(0, 300));
      if (live.errors.length > PLAN_LIVE_ERR_MAX)
        live.errors.splice(0, live.errors.length - PLAN_LIVE_ERR_MAX);
      live.state = "error";
    } else if (type === "retry") {
      /* 出错自动重发（dshRunTask 触发 retry）：与节点 / 会话侧同一口径，看 resumed
         决定残文留不留 —— resumed=true 是「续写」，新内容接在同一条逻辑轮次后面，
         已观测到的正文 / 思考尾部一律保留；只有整轮重发才把尾部清零，
         否则重发那一轮的字会叠在失败轮后面（工具按 callId 记账，不重复，不清）。 */
      if (!data.resumed) {
        live.text = "";
        live.reasoning = "";
      }
    } else if (type === "done") {
      live.state = "done";
    } else {
      return false;
    }
    live.lastAt = now;
    return true;
  } catch (_) {
    return false;
  }
}

/* 子任务落定（成功 / 失败 / 被取消）：给轨迹定性，供面板定格显示 */
function planLiveSettle(live, err) {
  if (!live) return;
  const msg = err ? String((err && err.message) || err) : "";
  live.state = !err
    ? "done"
    : /中止|取消|cancel|abort|已终止/i.test(msg)
      ? "cancelled"
      : "error";
  if (err && msg && live.errors.indexOf(msg.slice(0, 300)) < 0)
    live.errors.push(msg.slice(0, 300));
  live.lastAt = Date.now();
}

/* ---- live 刷新：与 planTouch 同一口径——只有用户正在看这条会话才重绘 ----
 * 事件很密（逐 token），所以按 PLAN_LIVE_RENDER_MS 做 trailing 节流：
 * 窗口内的多次事件合并成一次面板局部刷新；期间切走会话自然不再刷。 */
function planLiveRenderNow(st) {
  try {
    if (
      typeof S !== "undefined" &&
      S &&
      S.agentActiveId === (st && st.id) &&
      typeof renderAgentPlanPanel === "function"
    )
      renderAgentPlanPanel(st);
  } catch (_) {}
}
function planScheduleLiveRender(st) {
  if (!st || st._planLiveTimer) return;
  st._planLiveTimer = setTimeout(() => {
    try {
      delete st._planLiveTimer;
    } catch (_) {
      st._planLiveTimer = null;
    }
    planLiveRenderNow(st);
    /* 运行队列上的「并行任务」行读的也是这份数据：同一窗口顺带刷一次 */
    try {
      if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
    } catch (_) {}
  }, PLAN_LIVE_RENDER_MS);
}
function planCancelLiveRender(st) {
  if (!st) return;
  try {
    if (st._planLiveTimer) clearTimeout(st._planLiveTimer);
  } catch (_) {}
  try {
    delete st._planLiveTimer;
  } catch (_) {
    st._planLiveTimer = null;
  }
}

/* 并行组开跑 / 收尾的记账：st._planPar 是纯运行时字段（不落盘）。
 * 并行期间 st.running 故意为 false（保用户改口语义），左下角运行队列必须靠它
 * 才知道「这条会话还在跑并行组」，并拿 runKeys 精确取消这一组。 */
function planParBegin(st, group, runKeys, runId) {
  if (!st) return;
  st._planPar = {
    group: String(group || ""),
    runKeys: Array.isArray(runKeys) ? runKeys.slice() : [],
    total: Array.isArray(runKeys) ? runKeys.length : 0,
    done: 0,
    at: Date.now(),
    runId: String(runId || ""),
  };
  planParNotify();
}
function planParEnd(st) {
  if (!st || !st._planPar) return;
  try {
    delete st._planPar;
  } catch (_) {
    st._planPar = null;
  }
  planParNotify();
}

/* 并行组这一「状态位」翻转时的统一通知：运行队列 + 会话列表条目 + 画布上的开发块徽标。
 * 三者读的都是下面 sessionBusyForUi 那份口径，所以必须同一时刻一起翻，
 * 少一个就出现「队列看得见、列表与功能块一路显示空闲」这种自相矛盾（本 bug）。
 * 全部 typeof 兜底：沙箱（test/smoke-plan-dialog.js）里只挂了队列桩，缺谁都不许抛。 */
function planParNotify() {
  try {
    if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
  } catch (_) {}
  try {
    if (typeof renderAgentSessionSidebar === "function")
      renderAgentSessionSidebar();
  } catch (_) {}
  try {
    /* 开发块的「运行中」徽标与呼吸灯只在 renderCanvas 时重画；并行组开跑 / 收尾
       各一次，频率极低（不是逐 token），不会打扰画布交互。 */
    if (typeof renderCanvas === "function") renderCanvas();
  } catch (_) {}
}

/* ---------- 「这条会话在跑吗」——展示口径的唯一真源 ----------
 * 两条并行存在的「在跑」：
 *   ① 会话自己那一轮（agent:<会话id>，st.running / 宿主智能节点在跑）；
 *   ② 用户名下的一组计划并行任务（planpar:* 那些 runKey，st.running 故意为 false）。
 * 凡是只用来「显示是否在跑」的地方一律走 sessionBusyForUi：
 *   · 会话列表条目（app-assist.js renderAgentSessionSidebar）
 *   · 开发块「绑定会话运行中」徽标 / 呼吸灯（app-devnode.js devNodeRunningState）
 *   · 队列里开发块行的文案取数与逐条停止（app.js）
 * 只看 ① 的旧写法会让整组并行任务跑完都在界面上显示「空闲」（本 bug）。
 * 交互口径不变，仍用 sessionIsRunning：能否立刻发下一条 / 要不要排队 / 能否压缩分支
 * 说的是「会话自己有没有被占用」，并行组不该把这些也一起锁上（那是改口语义）。 */
function planParBusy(st) {
  const par = st && st._planPar;
  if (!par || typeof par !== "object") return false;
  const total = Math.max(0, Number(par.total) || 0);
  if (!total) return false; /* 空组：没有东西在跑 */
  return Math.max(0, Number(par.done) || 0) < total; /* 全了结 = 正在收尾 */
}
function sessionBusyForUi(st) {
  if (!st) return false;
  let own = false;
  try {
    own =
      typeof sessionIsRunning === "function"
        ? !!sessionIsRunning(st)
        : !!st.running;
  } catch (_) {
    own = !!st.running;
  }
  return own || planParBusy(st);
}

/* ---------- 计划归属（owner）：一条计划只属于发起它的那个会话 / 那个节点 ---------- */
/* 按 id 取回仍然存在（且未归档）的 owner 会话；取不到返回 null。
   优先用宿主的 agentSessionById；沙箱里没有这个函数就返回 null（调用方回退到手中的 st）。 */
function planOwnerSession(st) {
  if (!st || !st.id) return null;
  try {
    if (typeof agentSessionById === "function") return agentSessionById(st.id);
  } catch (_) {}
  return null;
}
/* owner 会话是否还能接活：仍在会话列表里、且没被归档。
   拿不到会话列表的环境（测试沙箱）→ 视为可用，不误杀。 */
function planOwnerUsable(st) {
  if (!st || !st.id) return false;
  try {
    if (typeof agentSessions !== "function") return true;
    const live = (agentSessions() || []).find(
      (s) => s && s.id === st.id,
    );
    return !!(live && !live.archived);
  } catch (_) {
    return true;
  }
}
/* 弹窗标题上的归属标注：这条计划来自哪个会话 / 哪个功能块（多会话并行时不认错） */
function planOwnerLabel(owner) {
  if (!owner) return "";
  try {
    /* 节点模式：owner 就是节点本身，标注节点标题即可 */
    if (owner.kind) {
      const nt = String(owner.title || "").trim().slice(0, 28);
      const lab = owner.kind === "super" ? I18n.t("功能块") : I18n.t("智能节点");
      return nt ? lab + "「" + nt + "」" : "";
    }
    /* 会话模式：优先显示它绑定的功能块 / 智能节点，其次会话自身标题 */
    const sid = String(owner.id || "");
    const nodes = (typeof S !== "undefined" && S && S.wf && S.wf.nodes) || [];
    if (sid && Array.isArray(nodes)) {
      for (const n of nodes) {
        if (
          n &&
          n.agentSessionId === sid &&
          (n.kind === "agent_task" || (n.kind === "super" && n.dev))
        ) {
          const nt = String(n.title || "").trim().slice(0, 28);
          if (nt)
            return (
              (n.kind === "super" ? I18n.t("功能块") : I18n.t("智能节点")) +
              "「" +
              nt +
              "」"
            );
        }
      }
    }
    const t = String(owner.title || "").trim().slice(0, 28);
    return t ? I18n.t("会话") + "「" + t + "」" : "";
  } catch (_) {
    return "";
  }
}

/* ---------- 计划落盘为会话数据（st.plan：面板可见 · 状态回写 · 重启可续跑） ---------- */
/* 运行时执行器 st._planExec 只是 st.plan 的一份「游标」：派生自它、状态回写到它，
   所以重启（_planExec 丢失）后仍能从 st.plan 续跑，不会静默丢掉用户确认过的清单。
   两条硬规矩（治「计划串台 / 幽灵续跑」）：
   ① 计划永久绑死发起它的那个会话：st.plan.sessId 由 planStartExecution 打上，
      所有出口（自动续发、并行结果回写、面板按钮、水合）都先验归属，归属不对一律作废；
   ② 用户「终止」或「清除」= 这条计划就地永久消失：不保留 pending、不留可点的续跑按钮。 */
const PLAN_STEP_STATUSES = ["done", "active", "pending", "failed", "skipped"];
const PLAN_STEP_ICON = {
  done: "✓",
  active: "◐",
  pending: "○",
  failed: "✕",
  skipped: "⊘",
};
const PLAN_STEP_LABEL = {
  done: "已完成",
  active: "执行中",
  pending: "待执行",
  failed: "失败",
  skipped: "已跳过",
};
const PLAN_GOAL_MAX = 300;
const PLAN_DETAIL_MAX = 3000;

function planStepStatus(v) {
  const s = String(v || "").toLowerCase();
  return PLAN_STEP_STATUSES.indexOf(s) >= 0 ? s : "pending";
}
/* 清洗一份计划（写入配置前 / 载回后都过一遍）：脏字段、超长文本、非法状态一律归一。
   没有可用步骤 → null（面板与续跑都不认这份计划）。 */
function planSanitize(p) {
  if (!p || typeof p !== "object") return null;
  const raw = Array.isArray(p.steps) ? p.steps : [];
  const steps = [];
  for (const x of raw.slice(0, PLAN_MAX_TASKS)) {
    if (!x || typeof x !== "object") continue;
    const title = String(x.title || "").trim().slice(0, 200);
    if (!title) continue;
    steps.push({
      n: steps.length + 1,
      title,
      detail: String(x.detail || "").trim().slice(0, PLAN_DETAIL_MAX),
      model: String(x.model || "").trim().slice(0, 120),
      parallel: String(x.parallel || "").trim().slice(0, 40),
      status: planStepStatus(x.status),
    });
  }
  if (!steps.length) return null;
  const plan = {
    goal: String(p.goal || "").trim().slice(0, PLAN_GOAL_MAX),
    excludes: Array.isArray(p.excludes)
      ? p.excludes.map((x) => String(x || "").trim().slice(0, 200)).filter(Boolean).slice(0, 8)
      : [],
    at: Number(p.at) || 0,
    source: String(p.source || "").trim().slice(0, 40),
    /* 归属会话 id：跟着计划一起落盘，载回后据此判断「这份计划还属于这个会话吗」 */
    sessId: String(p.sessId || "").trim().slice(0, 40),
    /* 沿用来源：这份计划是从哪条会话整份搬过来的（同功能块新绑定会话），空 = 本会话自己规划 */
    inheritedFrom: String(p.inheritedFrom || "").trim().slice(0, 40),
    idx: 0,
    steps,
  };
  planSyncIdx(plan);
  return plan;
}
/* idx = 第一条还没跑到的步骤下标（全部跑完 = steps.length）：面板进度与续跑入口都读它 */
function planSyncIdx(plan) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  let i = plan.steps.length;
  for (let k = 0; k < plan.steps.length; k++) {
    const s = plan.steps[k];
    if (!s || s.status === "pending" || s.status === "active") {
      i = k;
      break;
    }
  }
  plan.idx = i;
  return plan;
}
function planSteps(st) {
  const p = st && st.plan;
  return p && Array.isArray(p.steps) ? p.steps : [];
}
/* ---------- 计划归属：一份计划只属于发起它的那个会话，绝不在别的会话里被「接着跑」 ---------- */
/* 计划是否登记了归属会话 id（旧存档没有 sessId：按「属于本机这份会话」处理，不误伤） */
function planHasOwner(plan) {
  return !!(plan && String(plan.sessId || "").trim());
}
/* 会话自己看自己的计划：sessId 与 st.id 不一致 = 这份计划是复制 / 串台来的 → 一律作废 */
function planOwnedHere(st) {
  const p = st && st.plan;
  if (!p) return false;
  if (!planHasOwner(p)) return true;
  return String(p.sessId) === String((st && st.id) || "");
}
/* 运行时游标必须与它要落的会话同号：_planExec 是从 A 会话派生的，就只能回 A 会话跑。
   这一道闸拦住「上一轮的闭包 / 会话列表错位」把剩余任务塞进当前活动会话。 */
function planCursorOwned(st) {
  const pe = st && st._planExec;
  if (!pe) return false;
  if (!String(pe.sessionId || "").trim()) return true;
  return String(pe.sessionId) === String((st && st.id) || "");
}
/* 还没了结的步骤（done / skipped 之外）：续跑就是重放这一批 */
function planRemaining(st) {
  return planSteps(st).filter((s) => s && s.status !== "done" && s.status !== "skipped");
}
function planHasOpen(st) {
  return planRemaining(st).length > 0;
}
/* 回写 + 落盘 + 只刷当前查看会话的计划面板（后台会话改数据，不抢别人的视图） */
function planTouch(st) {
  try {
    planSyncIdx(st.plan);
  } catch (_) {}
  try {
    if (typeof persistAgentSession === "function")
      persistAgentSession().catch(() => {});
  } catch (_) {}
  try {
    if (typeof S !== "undefined" && S && S.agentActiveId === (st && st.id))
      renderAgentPlanPanel(st);
  } catch (_) {}
}
/* 从 st.plan 派生运行时执行器：只排未完成项（同 parallel 组仍会并发成一步） */
function planDeriveExec(st) {
  const rest = planRemaining(st);
  return {
    sessionId: st.id,
    /* 这一次执行的身份证号：只有 still-属于本轮的收尾才允许续跑，
       用户中途点「▶ 继续执行」另起一轮后，旧轮次的收尾会自动闭嘴。 */
    runId: String(typeof uid === "function" ? uid("pr") : "pr" + Date.now()),
    steps: planBuildSteps(rest),
    idx: 0,
    done: 0,
    total: planSteps(st).length || rest.length,
    cur: [], /* 本轮在跑的步骤对象（引用 st.plan.steps 里的项，改它即改计划） */
  };
}
/* 一轮结束给在跑的步骤定性：出错 → failed；否则 done。并行组在 planRunParallel 里按各自结果写。 */
function planSettleRunning(st, outcome) {
  const pe = st && st._planExec;
  if (!pe || !Array.isArray(pe.cur) || !pe.cur.length) return false;
  const bad = outcome === "error" || outcome === "cancelled";
  for (const t of pe.cur) {
    if (t && t.status === "active") t.status = bad ? "failed" : "done";
  }
  pe.cur = [];
  planTouch(st);
  return true;
}
/* 本轮被打断（用户终止）：没有下一轮来结算它。
   终止 = 用户不要这份计划了 → 整份永久作废（planDrop），不退回「待执行」留续跑按钮；
   只有非终止的收尾（如跑完 / 出错停下）才把在跑的那一步退回 pending 供手动续跑。 */
function planInterruptRound(st, opts) {
  if (!st || !st.plan) return false;
  const mode = (opts && opts.mode) || "pause";
  if (mode === "drop") return planDrop(st, mode);
  const pe = st._planExec;
  if (pe) pe.cur = [];
  let changed = false;
  for (const s of planSteps(st)) {
    if (s && s.status === "active") {
      s.status = "pending";
      changed = true;
    }
  }
  if (changed) planTouch(st);
  return changed;
}
/* 计划执行器消息的固定抬头（判定用：发送队列里据此剔除已作废计划的残留任务） */
function planIsExecText(text) {
  const s = String(text || "").trim();
  return /^【执行已确认计划/.test(s) || /^\[Execute confirmed plan/.test(s);
}
/* ---------- 计划永久消失（终止 / 清除 / 弹窗里取消 / 归属不符） ----------
 * 一次把计划数据、运行时游标、待弹窗、排队弹窗、落盘标记、发送队列里的残留任务全部清掉：
 * 关掉应用重启后也不会再冒出这份计划，更不会跑到别的会话里去。 */
function planDrop(st, reason) {
  if (!st) return false;
  const had = !!st.plan || !!st._planExec;
  /* 先加计数：已排队、还没弹出来的那份确认框 resolve 后会看到计数对不上 → 不再启动 */
  try {
    st._planDrops = (Number(st._planDrops) || 0) + 1;
  } catch (_) {}
  st.plan = null;
  try {
    delete st._planExec;
  } catch (_) {}
  /* 排队中还没弹出的确认框一并丢掉（计数已 +1，即便某个弹窗已被显示也不会再启动） */
  try {
    planStalePendingOffers(st, reason || "drop");
  } catch (_) {}
  try {
    delete st._planDlgPending;
    delete st._planDlgWait;
  } catch (_) {}
  st._planDelivered = false;
  st.planCollapsed = false;
  st._planOpen = null;
  /* 排队消息里属于这份计划的任务：一并丢掉，否则下一轮结束后会被自动发出（= 突然执行旧计划） */
  try {
    if (Array.isArray(st.outbox) && st.outbox.length) {
      const keep = st.outbox.filter((x) => x && !planIsExecText(x.text));
      if (keep.length !== st.outbox.length) st.outbox = keep;
    }
  } catch (_) {}
  try {
    if (typeof persistAgentSession === "function")
      persistAgentSession().catch(() => {});
  } catch (_) {}
  try {
    if (typeof S !== "undefined" && S && S.agentActiveId === st.id)
      renderAgentPlanPanel(st);
  } catch (_) {}
  return had;
}
/* 载回配置时的水合：把可持久字段还原成运行时字段（重启后「▶ 执行计划」与「计划」面板仍在） */
function planHydrateSession(s) {
  if (!s || s._planHydrated) return s;
  s._planHydrated = true;
  try {
    /* 作废计数随会话一起载回（配置键 planDrops → 运行时 _planDrops，删掉配置键防旧值回写）。
       本任务起：终止 / 清除 / 归档 / 用户改口都会让计数 +1 并随会话落盘。 */
    s._planDrops = Math.max(0, Number(s.planDrops) || 0);
  } catch (_) {}
  try {
    delete s.planDrops;
  } catch (_) {}
  try {
    /* planDelivered 只是配置里的持久键：搬到运行时字段 _planDelivered 后删掉原键，
       否则下一次落盘会拿旧值把「▶ 执行计划」按钮又点亮。
       并且只在这条会话「最后一条就是那份计划」时才认：隔天回来、上下文早已往下翻了几页，
       那个按钮就不该还亮着（点它等于突然去执行一份早就不相干的旧计划）。 */
    if (s._planDelivered == null) {
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      const last = msgs[msgs.length - 1];
      s._planDelivered =
        !!s.planDelivered && !!last && last.role === "assistant";
    }
    delete s.planDelivered;
    if (s.plan) {
      /* 归属不是自己（分支 / 复制 / 历史串台留下的）→ 载回即作废，别在别人的会话里冒清单 */
      if (!planOwnedHere(s)) {
        s.plan = null;
      } else {
        const clean = planSanitize(s.plan);
        if (clean) {
          /* 上次退出时正在跑的那一步：进程已经没了，退回待执行，别让它永远转圈 */
          for (const t of clean.steps) if (t.status === "active") t.status = "pending";
          s.plan = planSyncIdx(clean);
          /* 水合后绝不自动开跑：续跑只能由用户点「▶ 继续执行」触发 */
          try {
            delete s._planExec;
          } catch (_) {}
        } else {
          s.plan = null;
        }
      }
    }
    /* 作废过的会话且存档里还残留 plan（崩溃 / 落盘失败的窗口）：
       就地作废 —— 重启、切会话、开新会话三条路都再也见不到这份计划，续跑入口绝不点亮。 */
    if (s.plan && (Number(s._planDrops) || 0) > 0) {
      s.plan = null;
      try {
        delete s._planExec;
      } catch (_) {}
    }
  } catch (_) {}
  return s;
}

/* ---------- 会话模式执行器（聊天 / 开发绑定会话；走 agentSessionSend 单轮 + 模型覆盖） ---------- */
function planStartExecution(st, tasks, meta) {
  if (!st || !Array.isArray(tasks) || !tasks.length) return false;
  /* owner 已不在（被删 / 归档）→ 不启动：绝不把这条计划交给当前活动会话 */
  if (!planOwnerUsable(st)) return false;
  meta = meta || {};
  const plan = planSanitize({
    goal: meta.goal,
    excludes: meta.excludes,
    at: Date.now(),
    source: meta.source || "confirm",
    /* 归属钉死在发起会话：重启载回 / 分支复制 / 闭包错拿 st 时都靠它判归属 */
    sessId: String(st.id || ""),
    steps: tasks,
  });
  if (!plan) return false;
  /* 新一轮覆盖旧一轮：先把上一份没跑完的计划就地作废，任何会话都只有一份活计划 */
  if (st.plan) {
    try {
      st.plan = null;
      delete st._planExec;
    } catch (_) {}
  }
  st.plan = plan; /* 确认执行即落盘为会话数据（面板可见 · 重启可续） */
  /* 新计划确认安装 = 作废计数清零：之前终止 / 清除 / 改口是对旧计划的账，
     不能牵连这份用户刚确认的新计划（否则它会被「作废过」误杀，续跑入口点不亮） */
  try {
    st._planDrops = 0;
  } catch (_) {}
  st._planExec = planDeriveExec(st);
  planTouch(st);
  planExecContinue(st);
  return true;
}
function planExecContinue(st) {
  const pe = st && st._planExec;
  if (!pe) return;
  /* 游标不是从这个会话派生的 → 立刻作废：这是「计划串台」的最后一道闸，
     宁可停下，也绝不把剩余任务发进别的会话。 */
  if (!planCursorOwned(st)) {
    try {
      delete st._planExec;
    } catch (_) {}
    return;
  }
  if (!planOwnedHere(st)) {
    try {
      planDrop(st, "foreign");
    } catch (_) {}
    return;
  }
  /* 跑到一半 owner 会话消失：就地作废剩余任务（宁可停下，也不发进别的会话） */
  if (!planOwnerUsable(st)) {
    try {
      planInterruptRound(st); /* 在跑的那一项退回「待执行」，不留永远转圈的幽灵 */
    } catch (_) {}
    try {
      delete st._planExec;
    } catch (_) {}
    return;
  }
  /* 上一轮已经结束：先按本轮结局给在跑的那一步定性并回写 st.plan，再决定下一步 */
  try {
    planSettleRunning(st, (st && st._roundOutcome) || "ok");
  } catch (_) {}
  /* 会话此刻正被占用（并行组收尾撞上用户又发了一轮等）：计划下一项绝不排队 ——
     排队会在无关轮次结束后被当普通消息自动发出（= 幽灵执行）。
     就地结束本轮：剩余项留待用户点面板「▶ 继续执行」。 */
  if (typeof sessionIsRunning === "function" && sessionIsRunning(st)) {
    try {
      delete st._planExec;
    } catch (_) {}
    try {
      planExecDone(st);
    } catch (_) {}
    return;
  }
  if (pe.idx >= pe.steps.length) {
    delete st._planExec;
    planExecDone(st);
    return;
  }
  const step = pe.steps[pe.idx++];
  if (step.kind === "seq") {
    const t = step.task;
    pe.done++;
    pe.cur = t ? [t] : [];
    if (t) t.status = "active"; /* 计划项进入「执行中」，面板上立刻看得见 */
    planTouch(st);
    const i = (t && t.n) || pe.done;
    /* sessionId：这一轮严格回到 owner 会话 —— runKey / 发送队列 / 工作区 /
       服务商与模型全部落在它身上，用户中途切会话也不会串台。 */
    void agentSessionSend(planTaskMessage(t, i, pe.total || 1), {
      _planExec: true,
      sessionId: st.id,
      planRunId: pe.runId,
      provider: planRouteOfModel(t.model) || undefined,
      model: t.model || undefined,
    });
  } else {
    for (const t of step.tasks) if (t) t.status = "active";
    pe.cur = step.tasks.slice();
    planTouch(st);
    void planRunParallel(st, step.tasks);
  }
}
function planExecDone(st) {
  /* 收尾：把没跑到的步骤退回「待执行」（面板上仍是○，可继续执行），并汇总进度 */
  let left = 0;
  try {
    for (const s of planSteps(st)) {
      if (!s) continue;
      if (s.status === "active") s.status = "pending";
      if (s.status !== "done" && s.status !== "skipped") left++;
    }
    planTouch(st);
  } catch (_) {}
  try {
    toast(
      left
        ? I18n.t("计划跑到这里：还有 ") + left + I18n.t(" 项未完成，可在「计划」面板继续执行")
        : I18n.t("计划已全部执行完成"),
      left ? "warn" : "ok",
    );
  } catch (_) {}
  if (S.agentActiveId === st.id) {
    try {
      renderAgentSession();
    } catch (_) {}
  }
}
async function planRunParallel(st, tasks) {
  const n = tasks.length;
  /* 记下发起时的 runId：等结果的这段时间里用户可能已终止 / 清除 / 另起一轮 */
  const runId0 = (st._planExec && st._planExec.runId) || "";
  const group = String((tasks[0] && tasks[0].parallel) || "").trim();
  const runKeys = [];
  const runs = tasks.map((t, k) => {
    /* 每个子任务一条可预测 runKey + 一份 live 轨迹：取消有句柄、观测有数据 */
    const runKey = planParRunKey(st.id, t, k);
    runKeys.push(runKey);
    t._live = planLiveInit();
    return planDshRunOnce(planTaskMessage(t, 0, n, true), {
      runKey,
      /* 继承 owner 会话的所属画布：子任务写的文件与画布都跟着那条会话，不看前台切到哪张图 */
      canvasWfId: st.canvasWfId || "",
      workspace: st.workspace || "",
      preset: st.preset || AGENT_PRESET_DEFAULT,
      provider: planRouteOfModel(t.model) || st.provider || planDefaultProvider(),
      model: t.model || st.model || undefined,
      effort: st.effort || "high",
      onEvent: (type, data) => {
        if (planLiveFeed(t._live, type, data)) planScheduleLiveRender(st);
      },
    }).then(
      (v) => {
        planLiveSettle(t._live, null);
        if (st._planPar) st._planPar.done = Math.min(n, (st._planPar.done || 0) + 1);
        planScheduleLiveRender(st);
        return v;
      },
      (e) => {
        planLiveSettle(t._live, e instanceof Error ? e : new Error(String(e || "")));
        if (st._planPar) st._planPar.done = Math.min(n, (st._planPar.done || 0) + 1);
        planScheduleLiveRender(st);
        throw e;
      },
    );
  });
  /* 开跑前登记这一组（运行队列靠它显示 + 停止）；异常也必须摘除 → finally */
  planParBegin(st, group, runKeys, runId0);
  let results = [];
  try {
    results = await Promise.allSettled(runs);
  } finally {
    /* 轨迹是纯运行时字段：整组了结即清空，状态由下面的 planTouch 定格进 st.plan */
    for (const t of tasks) {
      try {
        t._live = null;
      } catch (_) {}
    }
    planCancelLiveRender(st);
    planParEnd(st);
    /* 立刻补一次刷新（节流定时器已被取消）：面板不会留下一块永远挂着的 live 区 */
    planLiveRenderNow(st);
  }
  const lines = tasks.map((t, k) => {
    const r = results[k];
    const body =
      r.status === "fulfilled"
        ? String(r.value || "").trim()
        : I18n.t("失败：") + ((r.reason && r.reason.message) || String(r.reason || ""));
    return "【" + String(t.title || "").trim() + "】" + (body || I18n.t("（无输出）"));
  });
  /* 等并行结果的这段时间里 owner 可能已被删除 / 归档：
     结果就地丢弃，不写进任何别的会话，也不再续跑。 */
  if (!planOwnerUsable(st)) {
    try {
      planInterruptRound(st);
    } catch (_) {}
    try {
      delete st._planExec;
    } catch (_) {}
    return;
  }
  const owner = planOwnerSession(st) || st; /* 写回列表里当前那份会话对象 */
  /* 并行组各自有结果：先逐条定性，不留永远转圈的那一步（哪怕游标已被终止 / 清除掉） */
  try {
    for (let k = 0; k < tasks.length; k++) {
      const t = tasks[k];
      if (t && t.status === "active")
        t.status = results[k] && results[k].status === "fulfilled" ? "done" : "failed";
    }
  } catch (_) {}
  const pe = owner._planExec;
  if (pe) {
    pe.done += n;
    try {
      pe.cur = [];
    } catch (_) {}
  }
  /* 等结果的这段时间里计划被终止 / 清除 / 归属变了：结果就地丢弃，
     既不伪装成用户消息写进会话，也绝不接着跑后面的任务。 */
  if (!pe || String(pe.runId || "") !== String(runId0 || "") || !owner.plan || !planOwnedHere(owner)) {
    try {
      delete owner._planExec;
    } catch (_) {}
    try {
      planTouch(owner);
    } catch (_) {}
    return;
  }
  planTouch(owner);
  owner.messages.push({
    role: "user",
    content: I18n.t("【并行任务完成】\n") + lines.join("\n\n"),
    _src: "plan-exec",
    at: Date.now(),
  });
  try {
    await persistAgentSession();
  } catch (_) {}
  try {
    renderAgentSessionSidebar();
  } catch (_) {}
  if (S.agentActiveId === owner.id) {
    try {
      renderAgentSession();
    } catch (_) {}
  }
  planExecContinue(owner);
}

/* ---------- agent_task 节点模式执行器（节点保持运行中；逐项 dshRunTask + 模型覆盖） ---------- */
/* 并行子任务共用一个节点的输出区：给增量文本的每一行都加上【任务标题】前缀，
   末尾换行不额外补前缀（否则思考流里会冒出一行光杆标题）。 */
function planNodeLiveLine(title, s) {
  const p = "【" + String(title || "").trim() + "】";
  return p + String(s == null ? "" : s).replace(/\n(?!$)/g, "\n" + p);
}

async function planNodeExec(node, tasks) {
  const steps = planBuildSteps(tasks);
  const total = tasks.length;
  let done = 0;
  const outs = [];
  for (const step of steps) {
    if (step.kind === "seq") {
      done++;
      outs.push(await planNodeRunRound(node, step.task, done, total));
    } else {
      const n = step.tasks.length;
      const runs = step.tasks.map((t, k) => {
        const title = String(t.title || "").trim();
        return planDshRunOnce(planTaskMessage(t, 0, n, true), {
          runKey: planParRunKey(node && node.id, t, k),
          workspace: node.workspace || "",
          preset: node.preset || AGENT_PRESET_DEFAULT,
          provider: planRouteOfModel(t.model) || String(node.provider || "").trim() || planDefaultProvider(),
          model: t.model || node.model || undefined,
          effort: node.effort || "high",
          /* 并行子任务共用同一份节点 Output / 思考流：事件直接转 onDshNodeEvent，
             并给每行冠上【任务标题】，否则三路输出会混成一坨看不是谁写的。 */
          onEvent: (type, data) => {
            try {
              if (typeof onDshNodeEvent !== "function") return;
              const d = data || {};
              if ((type === "text" || type === "reasoning") && d.text) {
                onDshNodeEvent(node, 0, type, {
                  ...d,
                  text: planNodeLiveLine(title, d.text),
                });
              } else if (type === "error" && d.message) {
                onDshNodeEvent(node, 0, type, {
                  ...d,
                  message: planNodeLiveLine(title, d.message),
                });
              } else if (type === "tool" && d.name) {
                onDshNodeEvent(node, 0, type, {
                  ...d,
                  name: "【" + title + "】" + d.name,
                });
              } else {
                onDshNodeEvent(node, 0, type, d);
              }
            } catch (_) {}
          },
        });
      });
      const results = await Promise.allSettled(runs);
      const lines = step.tasks.map((t, k) => {
        const r = results[k];
        const body =
          r.status === "fulfilled"
            ? String(r.value || "").trim()
            : I18n.t("失败：") + ((r.reason && r.reason.message) || String(r.reason || ""));
        return "【" + String(t.title || "").trim() + "】" + (body || I18n.t("（无输出）"));
      });
      const sum = I18n.t("【并行任务完成】\n") + lines.join("\n\n");
      node.messages.push({ role: "user", content: sum, _src: "plan-exec", at: Date.now() });
      done += n;
      outs.push(sum);
    }
  }
  return (
    I18n.t("已完成 ") + total + I18n.t(" 项计划任务。") + "\n\n" + (outs[outs.length - 1] || "")
  );
}
async function planNodeRunRound(node, task, i, n) {
  const msg = planTaskMessage(task, i, n);
  node.messages.push({ role: "user", content: msg, _src: "plan-exec", at: Date.now() });
  const hist = (node.messages || [])
    .slice(0, -1)
    .slice(-20)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const input = hist ? hist + "\n\n用户(最新)：" + msg : msg;
  const text = await dshRunTask(input, {
    node,
    provider: planRouteOfModel(task.model) || String(node.provider || "").trim() || planDefaultProvider(),
    model: task.model || node.model || undefined,
    effort: node.effort != null && node.effort !== "" ? node.effort : undefined,
    preset: node.preset || undefined,
    systemPrompt: "回答简洁。用工作区文件交付结果，不要改画布。",
    onEvent: (type, data) => {
      try {
        if (typeof onDshNodeEvent === "function") onDshNodeEvent(node, 0, type, data);
      } catch (_) {}
    },
    onDone: (d) => {
      try {
        if (typeof recordDshMetrics === "function") recordDshMetrics(node, d.metrics);
      } catch (_) {}
    },
  });
  const body = String(text || "").trim() || I18n.t("（已完成，无文本输出）");
  node.messages.push({ role: "assistant", content: body, at: Date.now() });
  return body;
}

/* ---------- 计划提供队列：弹窗一次只开一个，其余排队 ----------
 * 排队期间这条计划可能已经不该跑了（用户在别的会话又发了一轮 / 手动跑了别的会话 /
 * 这份会话已有活计划 / 刚被终止或清除）→ 弹窗前与确认后各校验一次，过期直接丢弃。 */
const _planOfferQueue = [];
let _planDlgBusy = false;
/* 一个确认框的生命周期结束（弹窗已 answer 或已被丢弃）：摘掉「活着」记账 */
function planOfferLift(item) {
  try {
    if (item && item.st && item._live) {
      item._live = false;
      item.st._planOfferLive =
        Math.max(0, (Number(item.st._planOfferLive) || 1) - 1);
    }
  } catch (_) {}
}
function planOfferPush(item) {
  return new Promise((resolve) => {
    item.resolve = resolve;
    try {
      item.gen = item.st ? Number(item.st._planDrops) || 0 : 0;
      item.at = Date.now();
      /* 记账：这份会话此刻有一个「活着」的确认框（排队中或已弹出）。
         作废计数只在真有活确认框时 +1，普通聊天轮次不污染计数。 */
      if (item.st) {
        item._live = true;
        item.st._planOfferLive = (Number(item.st._planOfferLive) || 0) + 1;
      }
    } catch (_) {}
    _planOfferQueue.push(item);
    planOfferDrain();
  });
}
/* 丢掉这条会话「排队中还没弹出」的全部计划确认框，并把会话的作废计数 +1：
   用户改口 / 终止 / 清除之后，这些过期弹窗绝不能再弹给他。
   计数 +1 同时让**已经显示在手上的那一份**失效：之后即使他点了「确认执行」
   也不会启动（只提示计划已过期）——他真想要，让 agent 重新出一份就是。
   每个被移走的弹窗都 resolve(null)，挂起计数由 planMaybeOffer 的收尾自己递减复位。 */
function planStalePendingOffers(st, reason) {
  if (!st) return 0;
  let n = 0;
  for (let i = _planOfferQueue.length - 1; i >= 0; i--) {
    const it = _planOfferQueue[i];
    if (!it || it.kind !== "session" || it.st !== st) continue;
    _planOfferQueue.splice(i, 1);
    n++;
    /* 只 resolve：挂起计数由 planMaybeOffer 的收尾自己递减复位，这里不抢着改 */
    try {
      if (it.resolve) it.resolve(null);
    } catch (_) {}
  }
  /* 计数 +1 只在真有「排队中或已弹出的确认框」时才做：让手上（或排队中）的那一份
     也失效（用户改口 = 这份计划作废，之后即使点了「确认执行」也不会启动，只会提示过期）。
     反过来，计划弹窗之外的普通聊天轮次绝不 +1 —— 计数语义 =「这份会话的计划被作废过
     几次」，聊天轮次污染它会让水合后计数恒 > 0，误杀仍在面板上可正常续跑的已确认计划。 */
  const hasLive =
    n > 0 ||
    (Number(st._planOfferLive) || 0) > 0 ||
    (Number(st._planDlgWait) || 0) > 0;
  if (hasLive) {
    try {
      st._planDrops = (Number(st._planDrops) || 0) + 1;
    } catch (_) {}
  }
  return n;
}
/* 这一份「请用户确认计划」的弹窗是否已经过期（过期 = 不再弹、绝不启动） */
function planOfferStale(item) {
  try {
    if (!item) return true;
    if (item.kind !== "session") return false;
    const st = item.st;
    if (!st || !planOwnerUsable(st)) return true;
    /* 归属校验：这条弹窗是为 st 这个会话许的，只能由它确认（防止切会话后误开） */
    if (String((item.plan && item.plan.sessId) || "") && String(item.plan.sessId) !== String(st.id))
      return true;
    /* 这份会话正在跑另一份计划 → 旧的确认框作废，不叠加启动
       （只是「有一份没跑完的计划」不算作废：新计划一旦确认就整份接管它） */
    if (st._planExec) return true;
    /* 期间被终止 / 清除过（计数变了）→ 用户已经不要它了 */
    if ((Number(st._planDrops) || 0) !== (Number(item.gen) || 0)) return true;
    return false;
  } catch (_) {
    return false;
  }
}
async function planOfferDrain() {
  if (_planDlgBusy || !_planOfferQueue.length) return;
  _planDlgBusy = true;
  try {
    while (_planOfferQueue.length) {
      const item = _planOfferQueue.shift();
      try {
        /* 排队 / 上一个弹窗期间，owner 会话可能已被删除、归档或计划已被终止 / 清除：
           直接丢弃这一项（resolve 让它复位挂起标记），绝不把它的计划弹给别的会话。 */
        if (item.kind === "session" && planOfferStale(item)) {
          try {
            if (item.resolve) item.resolve(null);
          } catch (_) {}
          continue;
        }
        const res = await planConfirmDialog(item.owner, item.plan, item.prev);
        if (item.kind === "session") {
          /* 弹窗期间 owner 可能刚被删掉 / 计划已被清掉：确认了也不能启动 */
          const usable = planOwnerUsable(item.st) && !planOfferStale(item);
          const wantGo = !!(res && res.action === "go");
          let started = false;
          if (wantGo && usable)
            started = planStartExecution(item.st, res.tasks, {
              goal: item.plan && item.plan.goal,
              excludes: item.plan && item.plan.excludes,
              /* 计划来源标注：来自哪个归属（会话 / 功能块），面板与排错时能对上号 */
              source: planOwnerLabel(item.owner) || "confirm",
            });
          else if (wantGo) {
            try {
              toast(I18n.t("这份计划已过期或所属会话已关闭，未执行"), "warn");
            } catch (_) {}
          } else if (item.st && planOwnerUsable(item.st)) {
            /* 取消 ≠ 丢掉沿用来的那份清单：把让位前的计划原样还回面板，仍可手动续跑 */
            try {
              if (!item.st.plan && item.prev) {
                item.st.plan = item.prev;
                planTouch(item.st);
              }
            } catch (_) {}
            item.st.messages.push({
              role: "user",
              content: I18n.t("用户取消了该计划，未执行任何改动。"),
              _src: "plan-exec",
              at: Date.now(),
            });
            try {
              await persistAgentSession();
            } catch (_) {}
            try {
              if (S.agentActiveId === item.st.id) renderAgentSession();
              else renderAgentSessionSidebar();
            } catch (_) {}
          }
          /* 会话模式同样必须 resolve：否则 planMaybeOffer 的收尾不执行，
             st._planDlgPending 永久为 true → 该会话再也拿不到「任务流程」注入。 */
          try {
            if (item.resolve) item.resolve(started ? "go" : "cancel");
          } catch (_) {}
        } else {
          if (res && res.action === "go") {
            let sum = "";
            try {
              item.node._planExec = true;
              sum = await planNodeExec(item.node, res.tasks);
            } finally {
              delete item.node._planExec;
            }
            item.resolve(sum);
          } else {
            item.node.messages.push({
              role: "user",
              content: I18n.t("用户取消了该计划，未执行任何改动。"),
              _src: "plan-exec",
              at: Date.now(),
            });
            item.resolve(I18n.t("（计划已取消，未执行任何改动）"));
          }
        }
      } catch (e) {
        try {
          if (item.resolve) item.resolve(null);
        } catch (_) {}
      } finally {
        /* 一个确认框的生命周期结束（answer 或已被丢弃）：摘掉「活着」记账 */
        planOfferLift(item);
      }
    }
  } finally {
    _planDlgBusy = false;
  }
}
/* 会话模式入口：一轮结束后扫描到计划标记 → 入队弹窗
   （计数而不是布尔：同一会话排了几份计划，就等几个弹窗都处理完再复位，
     否则第一个弹窗 resolve 后会提前放行「任务流程」注入） */
function planMaybeOffer(st, plan) {
  if (!st || !plan) return;
  /* 弹窗与计划数据都钉上归属会话：确认后只可能开在这条会话上 */
  try {
    plan.sessId = String(st.id || "");
  } catch (_) {}
  /* 一份会话只留一份活计划：这里不动旧计划（用户可能只是还没跑完），
     新计划在用户确认时才整份接管它（planStartExecution 负责替换）。
     接管前先把旧计划快照给弹窗：未完成项预填进清单（可就地增删改），
     全部完成的只作「已完成参考」显示 —— 沿用 ≠ 自动续跑。 */
  let prev = null;
  try {
    if (st.plan && planOwnedHere(st)) prev = planSanitize(st.plan);
  } catch (_) {}
  st._planDlgPending = true;
  st._planDlgWait = (Number(st._planDlgWait) || 0) + 1;
  void planOfferPush({ kind: "session", st, plan, owner: st, prev }).then(() => {
    try {
      st._planDlgWait = Math.max(0, (Number(st._planDlgWait) || 1) - 1);
      if (!st._planDlgWait) st._planDlgPending = false;
    } catch (_) {
      try {
        st._planDlgPending = false;
      } catch (_2) {}
    }
  });
}
/* 节点模式入口：返回最终输出文本（null = 无计划，保持原输出） */
function planNodeOffer(node, text) {
  if (!node) return Promise.resolve(null);
  const plan = planParseFromText(String(text || ""));
  if (!plan) return Promise.resolve(null);
  return planOfferPush({ kind: "node", node, plan, owner: node });
}

/* ---------- 会话内「计划」面板（#agentPlan：复用任务清单卡样式与折叠交互） ----------
 * 弹窗只是一瞬间的确认；这份清单是会话的持久数据：
 *   · 头部 = 折叠 + 「计划」+ 完成数/总数 + 进度条 + 「继续执行 / 清除」
 *   · 逐条 = 状态图标（✓ ◐ ○ ✕ ⊘）+ 序号 + 标题 + 模型 / 并行组标签，点开看详情
 *   · render 只吃传进来的 st，切会话时由 renderAgentSession 重绘，绝不残留上一会话的内容
 * 节点模式（agent_task）不写 st.plan，因此不会在会话里冒出别人的清单。 */
function planPanelEl(tag, cls, txt) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt != null) el.textContent = txt;
  return el;
}
/* 只在清单容器内部把某个块滚进可视区：scrollIntoView 会连外层会话一起滚，
   用户点一行详情却把整个对话顶走，反而更像「滚不动了」。 */
function planScrollInList(list, node) {
  if (!list || !node || !node.getBoundingClientRect) return;
  try {
    const cr = list.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    if (nr.top < cr.top) list.scrollTop -= cr.top - nr.top;
    else if (nr.bottom > cr.bottom) list.scrollTop += nr.bottom - cr.bottom;
  } catch (_) {}
}
/* ---------- 计划清单高度：拖拽设定的是「最小高度」，往上仍可继续加高（全局偏好 agentPlanH） ----------
 * 旧版把 agentPlanH 写成清单的 max-height：120px 名义上是「最低」，实际是「封顶」——
 * 清单被摁死在一小截里，长计划只能反复滚；而且那个写死的值读不到「此刻还剩多少空间」，
 * 窗口一矮（或输入区 chips 换行变高），清单连同输入栏就被顶出 .agent-main，
 * 看起来就是「计划列表和下方对话栏重叠」。
 * 现在口径反过来：agentPlanH = 清单的最小高度（走 flex-basis），往上仍可继续拖高。两件事分开做：
 *  1) 真·空间分配由 renderer/css/base.css 的「会话底栏布局契约」①–⑤ 负责（消息区 basis 归 0 先让位
 *     → 面板可收缩但永不低于头部 → 面板内的缺口全落到清单上 → 任务卡 / 发送队列各自带头部下限
 *     + 内部列表封顶 → 输入区唯一钉死）。清单就算被设成当下放不下的高度，也只会自己变矮，绝不越过下沿。
 *  2) 本模块的夹取只做一件事：上限 = 此刻**真实放得下**的最大值，而且拖把手的每一步都实时按它夹，
 *     所以用户能一路拖到最大值就停手（旧版预算漏了发送队列、又拿被压扁后的兄弟项高度做减法，
 *     算出的上限比物理空间大 74~80px —— 松手就重叠，这就是「仍然存在 bug」）。
 * 预算一律实测、不再拿常量近似：#agentPlan 在 .agent-body 里的**全部**可见兄弟项都要先扣掉——
 * 输入区（⑤）、任务卡（④）、发送队列（④'），收起态的兄弟项就只剩它自己的头部（同样实测）。
 * 唯一保留的常量 PLAN_LIST_MSG_MIN_H 是我们主动给消息区留的下限（产品口径），不是对某个元素高度的猜测。
 * 落盘口径对齐 applyAgentSideWidth：S.agentPlanH 是即时值，拖动过程只改 CSS 变量、不落盘，
 * 松手（或双击还原）时才写 S.config.agentPlanH + configSave。S.config 里存的是「用户设定的值」，
 * 所以底栏重新变宽时清单会长回它，不会停在被临时夹小的那一档（见 applyAgentPlanH(null)）。
 * 重夹的触发口径也从「只有 window.resize」换成观察 .agent-body 与底栏各兄弟项的尺寸：
 * 拖左右分栏、输入区 chips 换行、任务卡 / 发送队列出现都不触发 window.resize，旧版因此一次也不重夹。
 * 注意：#agentPlan 每次重绘都整块 innerHTML 重建，把手元素活不过一次 live tick，
 * 所以拖拽状态一律挂在模块级变量 + document 监听上，--ap-h 写在稳定的 #agentPlan 上。 */
const PLAN_LIST_MIN_H = 120; /* 默认 = 最小高度（约 4 行；再矮就没法一眼看到进度），双击把手回到这里 */
const PLAN_LIST_MSG_MIN_H = 72; /* 无论清单多高，都必须给上方的会话消息区留这么多，免得会话被顶成一条缝 */
const PLAN_LIST_HEAD_H = 36; /* 面板头部 .at-head 实测高（base.css 契约② 的下限 38px 已含 2px 余量） */
const PLAN_LIST_GRIP_H = 7; /* 清单上方的拖拽把手（.ap-grip）高度：展开态面板下限 = 头部 + 把手 */
const PLAN_LIST_PANEL_H = 2; /* #agentPlan 自身的上下外边距（base.css 契约② 的 margin-bottom）量不到时的兜底 */
const PLAN_LIST_COMPOSER_H = 132; /* 输入区（chips + 两行输入 + 内边距）连文档都量不到时的兜底高度 */
const PLAN_GRIP_TIP = "向上拖拽加高计划清单 · 可拖到此刻放得下的最大值 · 双击回到默认最小高度";
let planGripDrag = null; /* { startY, startH } | null —— 拖拽中的唯一状态源 */
let planHostRO = null; /* 观察底栏尺寸的 ResizeObserver：宿主没换人就一直复用 */
let planHostWatched = null; /* 已被观察的那批元素：换宿主元素时才重建，重绘不重建 */
let planRemeasuring = false; /* 重夹过程中写的 CSS 变量不再回调一次（防回环的闸门） */

/* 量一个块此刻的整高（含边框）；面板还没显示 / 还没建出来时返回 0，由调用方决定兜底 */
function planRectH(el) {
  try {
    const r = el && el.getBoundingClientRect && el.getBoundingClientRect();
    return Math.ceil((r && r.height) || (el && el.offsetHeight) || 0);
  } catch (_) {
    return 0;
  }
}

/* 还没显示 / 还没建出来时用兜底值，保证不会算出负上限 */
function planBoxH(el, fallback) {
  const h = planRectH(el);
  return h > 0 ? h : fallback;
}

/* 计算样式里的一个长度：'none' / 沙箱里没有 getComputedStyle → null（= 没有这条约束），
   绝不能当成 0，否则「无上限」会被误算成「上限 0」。 */
function planCssPx(el, prop) {
  try {
    if (!el || typeof getComputedStyle !== "function") return null;
    const v = parseFloat(getComputedStyle(el)[prop]);
    return Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

/* 直接子元素里找第一个带指定 class 的（迷你 DOM 沙箱没有 children，也没有 :scope 选择器，自己过滤） */
function planChildByCls(el, names) {
  const kids = (el && (el.children || el.childNodes)) || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!c || !c.classList) continue;
    for (let j = 0; j < names.length; j++) if (c.classList.contains(names[j])) return c;
  }
  return null;
}

/* 元素自身在纵向上额外吃掉的尺寸：内边距 + 边框 + 外边距（rect 高度不含外边距，必须补回来） */
function planExtraVH(el) {
  const parts = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth", "marginTop", "marginBottom"];
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += planCssPx(el, parts[i]) || 0;
  return Math.ceil(n);
}

/* 绝对定位的装饰（如浮在输入区上方的下拉菜单）不吃 flex 主轴空间，别把它算进预算 */
function planTakesFlow(el) {
  try {
    if (typeof getComputedStyle !== "function") return true;
    const p = getComputedStyle(el).position;
    return p !== "absolute" && p !== "fixed";
  } catch (_) {
    return true;
  }
}

/* 会话消息区（契约① 的唯一填充项）：它的高度是「剩下的」，不参与预算求和，另按下限预留 */
function planIsFillArea(el) {
  const c = el && el.classList;
  if (c) {
    const names = ["hist-scroll-wrap", "agent-list", "assist-list", "chat-list", "agent-conv"];
    for (let i = 0; i < names.length; i++) if (c.contains(names[i])) return true;
  }
  return (planCssPx(el, "flexGrow") || 0) > 0;
}

/* 底栏某个兄弟项「没被压缩时」要占多高 —— 本任务的核心修正。
 * 契约④ 之后这些兄弟都是 flex:0 1 auto（可收缩）：直接量 rect 会量到**已经被砍过**的值，
 * 于是「面板越扁 → 预算越空 → 上限越算越大」，实测台 D 组抓到的就是这条自反馈（偏差 −74~−80px）。
 * 所以按「头部 + 内部列表（各自被 max-height 封顶：任务卡 190 / 队列 132）+ 自身边框内边距」
 * 把没被压缩时的自然高度重算出来；拆不出头部或列表（收起态整块就只剩头部）才退回整块实测。
 * 返回两者取大：宁可高估别人占的地方（清单少给几 px），也不能低估（那才会压到输入栏）。 */
function planSiblingH(el) {
  const used = planRectH(el);
  const head = planChildByCls(el, ["at-head", "aq-head"]);
  const list = planChildByCls(el, ["at-list", "aq-list"]);
  const headH = planRectH(head);
  if (!headH || !list) return used;
  const borderV = (planCssPx(list, "borderTopWidth") || 0) + (planCssPx(list, "borderBottomWidth") || 0);
  /* scrollHeight 是滚动容器里内容的完整高度（被裁掉的部分照样算），正好等于没压缩时的应占高 */
  const content = Math.ceil((list.scrollHeight || 0) + borderV);
  const cap = planCssPx(list, "maxHeight"); /* 全局 *{box-sizing:border-box} → max-height 就是含边框的外挡高 */
  const inner = cap == null ? content : Math.min(cap, content);
  return Math.max(used, Math.ceil(headH + inner + planExtraVH(el)));
}

/* 输入区高度：它就在 .agent-body 里，正常由兄弟遍历量到；万一面板被挪出该容器，
   仍要先给它留位（拿文档里的实测，再退常量）—— 输入栏绝不能被清单顶掉。 */
function planComposerReserveH() {
  try {
    const c = document.querySelector(".agent-composer");
    const h = planRectH(c);
    if (h > 0) return h;
  } catch (_) {}
  return PLAN_LIST_COMPOSER_H;
}

/* 此刻清单还能要到多高 = 宿主高 − 消息区下限 − 全部可见兄弟项实测 − 面板自身装饰（头部 + 把手 + 外边距）。
   每一项都顺着 #agentPlan 的宿主现量，包括收起态只剩一个 .at-head 的那种；量不到宿主
   （会话面板还没显示 / 迷你 DOM 冒烟）才退回视口保险值。 */
function agentPlanMaxH() {
  try {
    const el = document.getElementById("agentPlan");
    const host = el && el.parentElement;
    const hostH = (host && host.clientHeight) || 0;
    if (!el || hostH <= 0) return Math.round((window.innerHeight || 800) * 0.7);
    let used = PLAN_LIST_MSG_MIN_H; /* ① 主动给消息区留的下限（不是近似值） */
    const kids = host.children || host.childNodes || [];
    let sawComposer = false;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c || c === el || !c.classList || c.hidden) continue;
      if (planIsFillArea(c)) continue; /* 填充项已由上面的消息区下限代表 */
      if (c.classList.contains("agent-composer")) sawComposer = true;
      const h = planTakesFlow(c) ? planSiblingH(c) : 0;
      if (h > 0) used += h; /* 空壳（innerHTML 已清 / display:none）一点空间都不占 */
    }
    if (!sawComposer) used += planComposerReserveH();
    /* 面板自身装饰：头部与把手都是 flex:none（实测即自然高）；收起态没有把手，
       也照样按 7px 留着 —— 展开后就出现在那里，不能到时候又超出去。 */
    used +=
      planBoxH(planChildByCls(el, ["at-head"]), PLAN_LIST_HEAD_H) +
      planBoxH(planChildByCls(el, ["ap-grip"]), PLAN_LIST_GRIP_H) +
      (planExtraVH(el) || PLAN_LIST_PANEL_H);
    return hostH - used;
  } catch (_) {
    return Math.round((window.innerHeight || 800) * 0.7);
  }
}

function clampAgentPlanH(h) {
  const min = PLAN_LIST_MIN_H;
  const max = Math.max(min, Math.round(agentPlanMaxH()));
  const n = Math.round(Number(h) || min);
  return Math.max(min, Math.min(max, n));
}

/* 此刻能拖到的最大值（= 夹取上限，至少等于最小高度），拖拽时显示在把手 tooltip 上 */
function agentPlanCurMaxH() {
  return Math.max(PLAN_LIST_MIN_H, Math.round(agentPlanMaxH()));
}

/* 把高度写成 #agentPlan 上的 --ap-h：.agent-plan .at-list 的 flex-basis 读它，
   = 清单至少要这么高（内容更少也撑住这块），要更高就继续拖把手。
   h 传 null/undefined = 「按用户设定的值重夹一遍」：读 S.config（落盘里那份设定值），
   于是底栏重新变宽时清单会长回去，而不是停在空间紧张时被临时夹小的即时值。 */
function applyAgentPlanH(h, persist) {
  if (h == null) {
    const want = S && S.config ? Math.round(Number(S.config.agentPlanH) || 0) : 0;
    h = want > 0 ? want : S.agentPlanH;
  }
  S.agentPlanH = clampAgentPlanH(h);
  const el = document.getElementById("agentPlan");
  if (el) el.style.setProperty("--ap-h", S.agentPlanH + "px");
  if (persist !== false && S.config) {
    S.config.agentPlanH = S.agentPlanH;
    window.api.configSave(S.config).catch(() => {});
  }
}

/* 底栏任何一次尺寸变化都重夹一次清单：拖左右分栏（.agent-body 变高）、输入区 chips 换行、
 * 任务卡 / 发送队列出现或长高（后两者都会吃掉底栏高度）——这些全都不触发 window.resize，
 * 旧版一次也不会重夹，所以「一换行就压住输入栏」。观察对象只有底栏那几个稳定节点，
 * 不含 #agentPlan 自己（清单加高正是我们写的值，观察它就是自激回环）。
 * 只改 CSS 变量、绝不落盘（与 applyAgentSideWidth 一致）。 */
function watchAgentPlanHost() {
  try {
    const el = document.getElementById("agentPlan");
    const host = el && el.parentElement;
    if (!host) return;
    const targets = [host, document.querySelector(".agent-composer"), document.getElementById("agentTodo"), document.getElementById("agentQueue")].filter(Boolean);
    if (planHostRO && planHostWatched === targets[0]) return; /* 已经贴着同一批节点 */
    const remeasure = () => {
      if (planRemeasuring || planGripDrag) return; /* 拖拽过程中由 onMove 自己实时夹，别抢值 */
      planRemeasuring = true;
      try {
        applyAgentPlanH(null, false);
      } finally {
        planRemeasuring = false;
      }
    };
    if (typeof ResizeObserver === "function") {
      if (planHostRO) {
        try {
          planHostRO.disconnect();
        } catch (_) {}
      }
      planHostRO = new ResizeObserver(remeasure);
      for (let i = 0; i < targets.length; i++) planHostRO.observe(targets[i]);
      planHostWatched = targets[0];
    } else if (!planHostWatched) {
      /* 观察器不可用（迷你 DOM 冒烟 / 极老内核）：退回旧口径，至少 window.resize 还兜得住 */
      try {
        if (window.addEventListener) window.addEventListener("resize", remeasure);
        planHostWatched = targets[0];
      } catch (_) {}
    }
  } catch (_) {}
}

/* 把手元素可能被重绘换掉，高亮与光标一律按当前 DOM 重新贴 */
function planGripMark(on) {
  try {
    const el = document.getElementById("agentPlan");
    const g = el && el.querySelector(".ap-grip");
    if (g) g.classList.toggle("dragging", !!on);
    document.body.style.cursor = on ? "ns-resize" : "";
    document.body.style.userSelect = on ? "none" : "";
  } catch (_) {}
}

/* 把手 tooltip 实时报「现在多少 / 此刻最多多少」：拖到最大值时左边那个数字不再涨，
   用户一眼就看出到头了，不会以为卡住。把手可能被 live 重绘换掉，每次都重新取当前 DOM。 */
function planGripReadout() {
  try {
    const el = document.getElementById("agentPlan");
    const g = planChildByCls(el, ["ap-grip"]);
    if (!g) return;
    g.title =
      I18n.t(PLAN_GRIP_TIP) +
      " · " + S.agentPlanH + "px / " + I18n.t("当前最多") + " " + agentPlanCurMaxH() + "px";
  } catch (_) {}
}

function bindAgentPlanGrip(el, grip) {
  grip.title = I18n.t(PLAN_GRIP_TIP);
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || planGripDrag) return;
    ev.preventDefault();
    ev.stopPropagation();
    planGripDrag = {
      startY: ev.clientY,
      startH: clampAgentPlanH(S.agentPlanH),
    };
    planGripMark(true);
    /* 移动 / 抬手挂在 document 上：把手中途被 live 重绘替换也不会打断拖动 */
    const onMove = (e) => {
      if (!planGripDrag) return;
      /* 清单在把手下方：向上拖（Y 变小）= 增高。每一步都按「此刻实测的剩余空间」夹住，
         所以能真实拖到当前最大值就停手；预算里兄弟项取的是自然高（planSiblingH），不会跟着
         清单变高、别人被压扁而越算越空（旧版正是这条自反馈让把手能拖出物理上放不下的高度）。 */
      applyAgentPlanH(planGripDrag.startH + (planGripDrag.startY - e.clientY), false);
      planGripReadout();
    };
    const onUp = () => {
      if (!planGripDrag) return;
      planGripDrag = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      planGripMark(false);
      applyAgentPlanH(S.agentPlanH, true); /* 松手才落盘：拖到的就是此刻放得下的那个值 */
      planGripReadout();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
  /* 双击把手 = 回到默认最小高度（与 .agent-side-resize 双击还原同口径；落盘的也是这个设定值） */
  grip.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    applyAgentPlanH(PLAN_LIST_MIN_H, true);
    planGripReadout();
  });
  /* 底栏尺寸一变（拖分栏 / chips 换行 / 任务卡与发送队列出现）就按实测重夹，清单只会自己收缩，
     绝不把会话和输入栏顶没（不落盘，与 applyAgentSideWidth 一致）。
     冒烟测试的迷你 DOM 没有 ResizeObserver / window.addEventListener，内部已容错。 */
  watchAgentPlanHost();
  planGripReadout();
}

/* 「▶ 继续执行」：重启或中断之后，从未完成的那一项接着跑 */
function planResumeSession(st) {
  if (!st || !st.plan) return;
  /* 作废计数 > 0：这份计划确认后被终止 / 清除 / 用户改口过 → 续跑入口不再点亮 */
  if ((Number(st._planDrops) || 0) > 0) {
    try {
      toast(I18n.t("该计划已作废，无法继续执行"), "warn");
    } catch (_) {}
    return;
  }
  if (st._planExec) {
    try {
      toast(I18n.t("该计划正在执行中"), "warn");
    } catch (_) {}
    return;
  }
  if (!planOwnerUsable(st)) {
    try {
      toast(I18n.t("所属会话已不存在，计划已停止"), "warn");
    } catch (_) {}
    return;
  }
  try {
    if (typeof sessionIsRunning === "function" && sessionIsRunning(st)) {
      toast(I18n.t("会话正在运行中"), "warn");
      return;
    }
  } catch (_) {}
  if (!planHasOpen(st)) {
    try {
      toast(I18n.t("该计划已全部完成"), "ok");
    } catch (_) {}
    return;
  }
  st._planExec = planDeriveExec(st);
  st._planDelivered = false;
  planTouch(st);
  planExecContinue(st);
}
/* 「清除」：丢掉这份计划（已落地的改动不回滚）；还有未跑项时先确认 */
async function planClearSession(st) {
  if (!st || !st.plan) return;
  const left = planRemaining(st).length;
  try {
    if (left && typeof confirmDialog === "function") {
      const yes = await confirmDialog(
        I18n.t("清除本会话的计划清单？\n\n还有 ") +
          left +
          I18n.t(" 项未执行，清除后无法再接着跑（已经改好的内容不会被撤销）。"),
        { title: I18n.t("清除计划"), danger: true, okText: I18n.t("清除") },
      );
      if (!yes) return;
    }
  } catch (_) {
    return;
  }
  try {
    delete st._planExec;
  } catch (_) {}
  /* 统一走 planDrop：计划数据 + 游标 + 排队弹窗 + 队列残留一起消失（重启也不回来） */
  planDrop(st, "clear");
}
/* ---------- live 观测读数（渲染侧，只读 t._live，绝不写执行器） ----------
 * 并行子任务运行时把网关事件汇进 t._live（planLiveInit / planLiveFeed）。
 * 整组了结后执行器在 finally 里把 t._live 摘成 null，而「失败」正是在那一刻之后
 * 才被渲染的 —— 所以渲染侧另存一份 WeakMap 快照（随步骤对象一起消失、下划线字段
 * 不进 planSanitize 白名单、永不落盘），让失败行还能给出 error 摘要。 */
const _planLiveSnap = typeof WeakMap === "function" ? new WeakMap() : null;
const PLAN_LIVE_TOOL_SHOW = 20; /* 转写区最多铺最近 20 条工具调用（更早的只报个数） */

function planLiveOf(s) {
  if (!s || typeof s !== "object") return null;
  const live = s._live && typeof s._live === "object" ? s._live : null;
  if (live) {
    try {
      if (_planLiveSnap) _planLiveSnap.set(s, live);
    } catch (_) {}
    return live;
  }
  try {
    return (_planLiveSnap && _planLiveSnap.get(s)) || null;
  } catch (_) {
    return null;
  }
}
/* 读数格式化：优先用全局 fmtDur / fmtTok（与 dsh 指标口径一致），拿不到就地兜底 */
function planLiveDur(ms) {
  try {
    if (typeof fmtDur === "function") return fmtDur(ms);
  } catch (_) {}
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return s % 60 ? m + "m" + (s % 60) + "s" : m + "m";
}
function planLiveTok(n) {
  try {
    if (typeof fmtTok === "function") return fmtTok(n);
  } catch (_) {}
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
/* 紧凑状态条读数：已用时 · 最近工具 · 输出字数 · token 累计 */
function planLiveStat(live) {
  if (!live) return null;
  const started = Number(live.startedAt) || 0;
  const endAt =
    live.state === "running" ? Date.now() : Number(live.lastAt) || started || Date.now();
  const elapsed = started ? Math.max(0, endAt - started) : 0;
  const u = live.usage || {};
  const inp = Number(u.inputTokens) || 0;
  const outp = Number(u.outputTokens) || 0;
  const parts = [planLiveDur(elapsed)];
  if (live.lastTool) parts.push("🔧 " + live.lastTool);
  parts.push((Number(live.chars) || 0) + I18n.t("字"));
  parts.push("↑" + planLiveTok(inp) + " ↓" + planLiveTok(outp));
  const toolN = Number(live.toolCalls) || (Array.isArray(live.tools) ? live.tools.length : 0);
  return {
    text: parts.join(" · "),
    title: [
      I18n.t("已用时") + "：" + planLiveDur(elapsed),
      I18n.t("工具调用") + "：" + toolN + (live.lastTool ? " · " + I18n.t("最近") + " " + live.lastTool : ""),
      I18n.t("输出字数") + "：" + (Number(live.chars) || 0),
      I18n.t("token") + "：" + I18n.t("输入") + " " + inp + " · " + I18n.t("输出") + " " + outp +
        (Number(u.cacheReadTokens) || 0 ? " · " + I18n.t("缓存命中") + " " + u.cacheReadTokens : "") +
        (Number(u.reasoningTokens) || 0 ? " · " + I18n.t("思考") + " " + u.reasoningTokens : ""),
      live.state === "error"
        ? I18n.t("状态：出错")
        : live.state === "cancelled"
          ? I18n.t("状态：已取消")
          : live.state === "done"
            ? I18n.t("状态：已结束")
            : I18n.t("状态：执行中"),
    ].join("\n"),
  };
}
/* 失败行的 error 摘要（取最近一条，压成一行，短到能塞进状态条） */
function planLiveErrText(live, max) {
  if (!live) return "";
  const arr = Array.isArray(live.errors) ? live.errors.filter(Boolean) : [];
  const tools = Array.isArray(live.tools) ? live.tools : [];
  if (!arr.length) {
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      if (t && t.error) {
        arr.push(String(t.error));
        break;
      }
    }
  }
  const s = String(arr[arr.length - 1] || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = max || 72;
  return s.length > m ? s.slice(0, m) + "…" : s;
}
/* 详情里的流式转写区：工具调用列表 + 正文尾部（自身是滚动容器，贴底才跟随） */
function planLiveBlock(live) {
  const box = planPanelEl("div", "ap-live");
  box.setAttribute("data-live-state", String(live.state || "running"));
  const tools = Array.isArray(live.tools) ? live.tools.filter(Boolean) : [];
  if (tools.length) {
    const shown =
      tools.length > PLAN_LIVE_TOOL_SHOW ? tools.slice(tools.length - PLAN_LIVE_TOOL_SHOW) : tools;
    const wrap = planPanelEl("div", "ap-live-tools");
    if (shown.length !== tools.length)
      wrap.appendChild(
        planPanelEl(
          "div",
          "ap-tool ap-tool-more",
          "… " + (tools.length - shown.length) + I18n.t(" 次更早调用"),
        ),
      );
    for (const t of shown) {
      const cls = t.state === "error" ? "st-err" : t.state === "done" ? "st-ok" : "st-run";
      const it = planPanelEl("div", "ap-tool " + cls);
      it.appendChild(planPanelEl("b", "ap-tool-n", "🔧 " + (t.name || "?")));
      it.appendChild(
        planPanelEl(
          "i",
          "ap-tool-s",
          t.state === "error" ? "✕" : t.state === "done" ? "✓" : "…",
        ),
      );
      const sum = String(t.error || t.result || "").replace(/\s+/g, " ").trim();
      if (sum) it.appendChild(planPanelEl("span", "ap-tool-r", sum));
      const dur = t.at && t.since ? planLiveDur(Math.max(0, t.at - t.since)) : "";
      it.title =
        String(t.name || "") +
        (dur ? " · " + dur : "") +
        (t.args ? "\n" + I18n.t("入参") + "：" + t.args : "") +
        (t.result ? "\n" + I18n.t("结果") + "：" + t.result : "") +
        (t.error ? "\n" + I18n.t("错误") + "：" + t.error : "");
      wrap.appendChild(it);
    }
    box.appendChild(wrap);
  }
  const body = planPanelEl(
    "pre",
    "ap-live-text" + (live.text ? "" : " ap-live-idle"),
    live.text || I18n.t("（暂无正文输出）"),
  );
  box.appendChild(body);
  return box;
}
function renderAgentPlanPanel(st) {
  const el = document.getElementById("agentPlan");
  if (!el) return;
  /* 归属不是本会话的计划（分支复制 / 历史串台留下的）→ 就地作废，
     绝不在这条会话的视图里冒出别人的清单（planDrop 后 st.plan 为空，不会递归） */
  if (st && st.plan && typeof planOwnedHere === "function" && !planOwnedHere(st)) {
    try {
      planDrop(st, "foreign");
    } catch (_) {}
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  /* 作废计数 > 0：这份计划确认后被终止 / 清除 / 用户改口过 → 面板不再点亮任何续跑入口，
     残留清单一并就地作废（planDrop 保证彻底消失，重启、切会话都不再见到） */
  if (st && st.plan && (Number(st._planDrops) || 0) > 0) {
    try {
      planDrop(st, "obsolete");
    } catch (_) {}
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const steps = planSteps(st).filter(Boolean);
  if (!steps.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const done = steps.filter((s) => s.status === "done").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const executing = !!(st && st._planExec);
  const goal = String((st.plan && st.plan.goal) || "");
  const excl = (st.plan && Array.isArray(st.plan.excludes) ? st.plan.excludes : []).filter(Boolean);
  el.hidden = false;
  /* 重绘会整块 innerHTML 重建：先记下流式转写区此刻的滚动意图
     （贴底 = 继续跟随；用户往上翻 = 还原阅读位置，绝不把他拽回底部） */
  let liveStick = true;
  let liveTop = 0;
  try {
    const old = el.querySelector(".ap-live");
    if (old) {
      liveStick = typeof convStickOf === "function" ? !!convStickOf(old) : true;
      liveTop = Number(old.scrollTop) || 0;
    }
  } catch (_) {}
  /* 清单容器 .at-list 更要紧：执行期每隔 PLAN_LIVE_RENDER_MS 就整块重建一次，
     不显式还原就会把用户刚拖到一半的滚动条甩回顶部 —— 这正是「滚不到底」的根因。
     判定沿用会话那套贴底口径（bindConvStick / setConvScrollTop），但更保守：
     只有用户自己滚到过底部（_convStick 被真实滚动写成 true）才继续贴底跟随，
     其余一律原样回到他的阅读位置，绝不主动把他跳上跳下。
     换会话 / 换计划（plan 对象换了引用）= 全新清单，不还原旧位置。 */
  const listKey = "plan-list:" + String((st && st.id) || "");
  let listSnap = false;
  let listStick = false;
  let listTop = 0;
  try {
    const oldList = el.querySelector(".at-list");
    if (oldList && el._apListKey === listKey && el._apListPlan === st.plan) {
      listSnap = true;
      listStick = oldList._convStick === true;
      listTop = Number(oldList.scrollTop) || 0;
    }
  } catch (_) {}
  el._apListKey = listKey;
  el._apListPlan = st.plan;
  /* 本次渲染是否由「用户刚点开某条详情」触发：标记只由行点击设置、用完即清，
     live tick 的反复重绘绝不会一次次抢滚动（滚不到底的第二个根因）。
     判定必须显式认整数：Number(null) === 0，用 Number() 会把第 0 项误判成刚点开。 */
  const justOpen =
    Number.isInteger(st._planJustOpen) && st._planJustOpen >= 0
      ? st._planJustOpen
      : null;
  st._planJustOpen = null;
  let liveEl = null;
  let detailEl = null;
  el.innerHTML = "";
  el.classList.toggle("collapsed", !!(st && st.planCollapsed));
  /* ---- 头部 ---- */
  const head = planPanelEl("div", "at-head");
  const fold = planPanelEl("button", "at-fold");
  fold.type = "button";
  fold.textContent = st.planCollapsed ? "▸" : "▾";
  fold.title = I18n.t("展开 / 收起计划清单");
  fold.onclick = () => {
    st.planCollapsed = !st.planCollapsed;
    planTouch(st);
    renderAgentPlanPanel(st);
  };
  head.appendChild(fold);
  const title = planPanelEl("b", "at-title", I18n.t("计划"));
  if (goal) title.title = goal;
  head.appendChild(title);
  if (goal) {
    const g = planPanelEl("span", "ap-goal", goal);
    g.title =
      goal + (excl.length ? "\n" + I18n.t("明确不做") + "：" + excl.join("；") : "");
    head.appendChild(g);
  }
  const count = planPanelEl("span", "at-count" + (failed ? " has-fail" : ""));
  count.textContent =
    done + " / " + steps.length + (failed ? " · " + failed + I18n.t(" 失败") : "");
  count.title = I18n.t("完成 / 总数");
  head.appendChild(count);
  const bar = planPanelEl("i", "at-bar");
  const fill = planPanelEl("u");
  fill.style.width = Math.round((done / steps.length) * 100) + "%";
  bar.appendChild(fill);
  head.appendChild(bar);
  if (executing) {
    head.appendChild(planPanelEl("span", "ap-running", I18n.t("执行中…")));
  } else if (!planHasOpen(st)) {
    head.appendChild(planPanelEl("span", "ap-done", I18n.t("已完成")));
  } else {
    const go = planPanelEl("button", "ap-run mini");
    go.type = "button";
    go.textContent = "▶ " + I18n.t("继续执行");
    go.title =
      I18n.t("从第一条未完成的任务接着跑（剩余 ") +
      planRemaining(st).length +
      I18n.t(" 项 · 仍在本会话内执行）");
    go.onclick = () => planResumeSession(st);
    head.appendChild(go);
  }
  const clear = planPanelEl("button", "at-clear mini", I18n.t("清除"));
  clear.type = "button";
  clear.title = I18n.t("清除本会话的计划清单（不会撤销已完成的改动）");
  clear.onclick = () => void planClearSession(st);
  head.appendChild(clear);
  el.appendChild(head);
  if (st.planCollapsed) return;
  /* 清单最小高度每次重绘都按全局偏好 + 此刻实测的可用空间走一遍（只改 CSS 变量，不落盘）：
     启动路径万一没跑到，这里也兜得住；窗口变矮、输入区变高、任务卡 / 发送队列出现时
     上限跟着降，清单只会自己收缩，绝不越过下沿盖住下方对话栏。
     放在把手与清单建出来之前量最准：此刻 #agentPlan 只剩头部，底栏兄弟项都还没被挤压。 */
  try {
    applyAgentPlanH(S.agentPlanH, false);
  } catch (_) {}
  /* ---- 清单高度把手：向上拖增高（拖到的值即此后守住的最小高度），双击回默认最小 ---- */
  const grip = planPanelEl("div", "ap-grip");
  /* 先进 DOM 再绑定：bind 里要把「现在多少 / 当前最多多少」写进 tooltip，得能在面板里找着它 */
  el.appendChild(grip);
  bindAgentPlanGrip(el, grip);
  /* ---- 清单 ---- */
  const ul = planPanelEl("div", "at-list");
  steps.forEach((s, i) => {
    const stt = planStepStatus(s.status);
    const row = planPanelEl("div", "at-item ap-item st-" + stt);
    row.onclick = () => {
      const next = st._planOpen === i ? null : i;
      st._planOpen = next;
      /* 只有「刚点开」才允许把详情滚进可视区；收起与折叠都不抢滚动 */
      if (next === i) st._planJustOpen = i;
      renderAgentPlanPanel(st);
    };
    const ic = planPanelEl("span", "at-icon", PLAN_STEP_ICON[stt]);
    ic.title = I18n.t(PLAN_STEP_LABEL[stt]);
    row.appendChild(ic);
    row.appendChild(planPanelEl("i", "ap-n", String(s.n || i + 1)));
    const txt = planPanelEl("span", "at-text", String(s.title || ""));
    txt.title = String(s.title || "");
    row.appendChild(txt);
    if (s.parallel)
      row.appendChild(
        planPanelEl("span", "ap-tag", I18n.t("并行组") + " · " + s.parallel),
      );
    if (s.model) row.appendChild(planPanelEl("span", "ap-tag", s.model));
    /* ① 紧凑实时状态条：执行中 = 已用时 · 最近工具 · 输出字数 · token 累计；
       失败行 = 同一条上给 error 摘要（读数全部来自 t._live，无轨迹就不占位） */
    const live = planLiveOf(s);
    const stat =
      stt === "active" || stt === "failed" ? planLiveStat(live) : null;
    const errTxt = stt === "failed" ? planLiveErrText(live) : "";
    if (stat || errTxt) {
      const sEl = planPanelEl("span", "ap-stat" + (errTxt ? " ap-stat-err" : ""));
      sEl.textContent = errTxt ? "⚠ " + errTxt : stat.text;
      sEl.title = errTxt
        ? I18n.t("错误") + "：" + errTxt + (stat ? "\n" + stat.title : "")
        : stat.title;
      row.appendChild(sEl);
    }
    row.appendChild(
      planPanelEl("span", "ap-caret", st._planOpen === i ? "▾" : "▸"),
    );
    ul.appendChild(row);
    if (st._planOpen === i && (s.detail || s.model || s.parallel)) {
      const d = planPanelEl("div", "ap-detail");
      if (s.detail) d.appendChild(planPanelEl("p", null, s.detail));
      if (s.model)
        d.appendChild(
          planPanelEl("span", "ap-meta", I18n.t("执行模型") + "：" + s.model),
        );
      if (s.parallel)
        d.appendChild(
          planPanelEl(
            "span",
            "ap-meta",
            I18n.t("并行组") + "：" + s.parallel,
          ),
        );
      ul.appendChild(d);
      /* 展开后把详情滚进可视区：此刻 ul 还没挂进文档，直接 scrollIntoView 是空操作；
         先记下元素，等清单进 DOM、滚动位置还原之后再滚一次（且只在用户刚点开时）。 */
      if (justOpen === i) detailEl = d;
    }
    /* ② 流式转写区：挂在详情块下方（自己就是滚动容器，不与 .ap-detail 套娃） */
    if (st._planOpen === i && live) {
      liveEl = planLiveBlock(live);
      ul.appendChild(liveEl);
    }
  });
  el.appendChild(ul);
  /* 转写区真正挂进文档后才能定滚动：贴底才跟随（口径沿用 scrollElToBottomIfStuck），
     用户往上翻过就还原他的阅读位置，绝不每 250ms 把他拽回底部。 */
  if (liveEl) {
    try {
      if (typeof convStickOf === "function") liveEl._convStick = liveStick;
    } catch (_) {}
    if (!liveStick) {
      try {
        liveEl.scrollTop = liveTop;
      } catch (_) {}
    }
    try {
      if (typeof scrollElToBottomIfStuck === "function")
        scrollElToBottomIfStuck(liveEl, !!liveStick);
      else if (liveStick) liveEl.scrollTop = liveEl.scrollHeight;
    } catch (_) {}
  }
  /* 清单滚动还原：上一次重绘之后用户把滚动条拖到哪儿，这一次还在哪儿；
     他本来就停在底部则继续贴底跟随最新状态 —— 滚动条因此真能拖到底并停住。 */
  try {
    if (typeof bindConvStick === "function") bindConvStick(ul);
  } catch (_) {}
  if (listSnap) {
    try {
      if (typeof markConvStick === "function") markConvStick(ul, listStick);
      else ul._convStick = listStick;
      const top = listStick ? ul.scrollHeight : listTop;
      if (typeof setConvScrollTop === "function") setConvScrollTop(ul, top);
      else ul.scrollTop = top;
    } catch (_) {}
  }
  /* 用户刚点开的详情：等清单自己的滚动尘埃落定后再滚进可视区（只动清单，
     不顺带把外层会话也滚走）。live tick 走不到这里（justOpen 已用完即清）。 */
  if (detailEl && st._planOpen === justOpen)
    try {
      planScrollInList(ul, detailEl);
    } catch (_) {}
}
