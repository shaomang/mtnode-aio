"use strict";
/* ============ 开发节点「建议」按钮 ============
 * 需求：开发节点（super + dev:true）增加「建议」按钮 —— 点击后同样先弹对话框，
 * 由用户确认后才让 AI 主动评估：读项目真实代码 + 该模块的开发进度，给出 4 条
 * 「下一步该实现什么」的方案；对话框里允许多选、允许用户补充；用户选完可以在
 * 同一个对话框里再点「开发」，等同于用当前勾选的建议 + 补充内容直接开工。
 *
 * 三段式（同一对话框宿主 #mtDialog 内完成；调研中可「返回」把调研留在后台继续跑，
 * 完成后自动跳窗重弹方案清单；Esc 在调研中同样只「返回」、不会停止生成）：
 *   1) mtDialogForm 确认框：显示现状（类型 / 状态 / 项目根 / 子元素 / 历史会话 /
 *      上次建议），可选填「本轮关注点」→「确认生成建议」
 *   2) 只读调研中：实时显示 Agent 的工具调用（read/grep/git status…）与耗时，
 *      期间绝不写文件、不改画布（系统提示按规划模式的禁令约束）
 *   3) 方案清单：4 条（可多选 · 数字键 1-4 快速勾选）+ AI 评估摘要 + 真实证据
 *      +「补充说明」输入框 + 按钮「取消 / 换一批 / 开发」
 * 「开发」→ startDevSessionWithText()：与「开发」按钮完全同一条路径（新建绑定
 * 会话、状态转 wip、后台运行不跳视图），只是任务正文由勾选结果拼出来。
 *
 * 结果缓存在节点上（node.devSuggest：items / summary / basis / at / picked /
 * supplement），随工作流保存；再次点「建议」可直接查看上次结果而不必重跑模型。
 *
 * 调研本身是一个「后台作业」（见下方 devSuggestJobs）：运行态与对话框分离，
 * 同一个功能块同一时刻只允许一轮在途调研（入口幂等），不同功能块各跑各的。
 */
const DEV_SUGGEST_COUNT = 4;
const DEV_SUGGEST_PRIORITY = { high: "优先", mid: "常规", low: "可延后" };

function devSuggestRunKey(node) {
  return "devsuggest:" + ((node && node.id) || "x");
}
function devSuggestPriorityOf(v) {
  const s = String(v == null ? "" : v).toLowerCase();
  if (/高|优先|紧急|必须|必做|首要|必要|先行|^(p0|p1)$|high|urgent|must|critical/.test(s))
    return "high";
  if (/低|延后|以后|可选|锦上添花|之后|^(p2|p3)$|low|later|nice|optional/.test(s))
    return "low";
  return "mid";
}
function devSuggestPriorityText(p) {
  return I18n.t(DEV_SUGGEST_PRIORITY[p] || "常规");
}

/* ---------- 节点上的缓存（上次建议） ---------- */
function devSuggestOf(node) {
  const s = node && node.devSuggest;
  if (!s || !Array.isArray(s.items)) return null;
  const items = [];
  for (const el of s.items) {
    const title = String((el && el.title) || "").trim().slice(0, 80);
    if (!title) continue;
    items.push({
      id: String((el && el.id) || "o" + (items.length + 1)),
      title,
      desc: String((el && el.desc) || "").trim().slice(0, 500),
      priority: DEV_SUGGEST_PRIORITY[el && el.priority]
        ? el.priority
        : devSuggestPriorityOf(el && el.priority),
    });
  }
  if (items.length < 2) return null;
  return {
    at: Number(s.at) || 0,
    summary: String(s.summary || "").trim().slice(0, 500),
    basis: (Array.isArray(s.basis) ? s.basis : [])
      .map((b) => String(b || "").trim())
      .filter(Boolean)
      .slice(0, 6),
    picked: Array.isArray(s.picked) ? s.picked.map(String) : [],
    supplement: String(s.supplement || "").trim(),
    items: items.slice(0, DEV_SUGGEST_COUNT),
  };
}
function devSuggestStamp(at) {
  const t = Number(at) || 0;
  if (!t) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return I18n.t("刚刚");
  if (min < 60) return min + I18n.t(" 分钟前");
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + I18n.t(" 小时前");
  return fmtTime(t);
}

/* ---------- 运行状态判定（自身 / 后代节点 / 绑定会话 / 建议调研） ---------- */
/* 开发节点“运行中”的四种来源，返回：
 *   "self" —— 节点自身正在运行（整块作为超级节点被执行）
 *   "desc" —— 块内任意后代节点（递归，含子开发节点）正在运行
 *   "sess" —— 绑定的开发 / 细化会话正在运行（含它名下在跑的计划并行组：
 *              那一组跑时会话自己的 st.running 故意为 false，判定走 sessionBusyForUi）
 *   "sug"  —— 本功能块有在途只读调研（「建议」devSuggestJobs）
 *              （「问询」不再是后台作业：它跑在该功能块的只读会话里，见 app.js
 *               startDevAskSession，进度与回答都在会话中，不占本处的运行态）
 *   null   —— 未运行
 * 画布据此给节点加 .dev-running 类：头部显示运行徽标 + 边框呼吸灯
 * （sug 态用另一套琥珀色呼吸灯 .dev-running-sug，见 canvas.css）。
 * 只读调研（建议）是轻量的后台作业，放在最后判定，其它更重的
 * 运行态优先占位；devRunningNodes 据此把它列进左下角运行队列（可单独停止）。
 * wfNodes 可指定后代扫描所在的工作流节点数组（默认当前画布 S.wf.nodes）。 */
function devNodeRunningState(node, wfNodes) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return null;
  if (node.running) return "self";
  const all = Array.isArray(wfNodes)
    ? wfNodes
    : (S.wf && S.wf.nodes) || [];
  const walk = (host, seen) => {
    for (const c of all) {
      if (!c || seen.has(c.id)) continue;
      if (nodeParentSuperId(c) !== host.id) continue;
      if (typeof isSuperIoNode === "function" && isSuperIoNode(c)) continue;
      seen.add(c.id);
      if (c.running) return true;
      if (c.kind === "super" && walk(c, seen)) return true;
    }
    return false;
  };
  if (walk(node, new Set())) return "desc";
  /* 绑定会话（最近一次 + 历史）任一在跑也算运行中。
     走展示口径 sessionBusyForUi：会话名下跑「计划并行组」时 st.running 故意为 false
     （保用户改口），只看 sessionIsRunning 会让功能块在整组并行期间不亮呼吸灯。 */
  const sessions =
    typeof agentSessions === "function" ? agentSessions() : [];
  for (const id of devSessionIdsOf(node)) {
    const st = sessions.find((s) => s && s.id === id);
    if (!st) continue;
    const busy =
      typeof sessionBusyForUi === "function"
        ? sessionBusyForUi(st)
        : typeof sessionIsRunning === "function"
          ? sessionIsRunning(st)
          : !!st.running;
    if (busy) return "sess";
  }
  /* 在途只读调研：「建议」（入口幂等保证同一块同一时刻最多一轮） */
  if (typeof devSuggestJobBusy === "function" && devSuggestJobBusy(node))
    return "sug";
  return null;
}

/* 当前画布中「运行中」的开发节点列表（自身 / 后代 / 绑定会话 / 建议调研任一运行，
 * 不含 db 超级节点）。供左下角运行队列展示（与处理节点同款行）：队列据此把
 * desc / sess / sug 态的开发块列进「处理中」，点击定位、逐条停止（stopNode 的
 * 开发分支，sug 态只取消调研作业）与「全部终止」都能复用同一判定。
 * wfNodes 可指定工作流节点数组（默认当前画布 S.wf.nodes）；返回的是其中的开发节点（引用）。 */
function devRunningNodes(wfNodes) {
  const out = [];
  const all = Array.isArray(wfNodes) ? wfNodes : (S.wf && S.wf.nodes) || [];
  for (const n of all) {
    if (!n || n.kind !== "super" || !n.dev || n.db) continue;
    if (devNodeRunningState(n, all)) out.push(n);
  }
  return out;
}

/* ---------- 两段式概述解析（共享） ----------
 * note 两段式规范（docs/dev-node-design.md §6）：【功能】非技术说明 + 【实现】工程梗概。
 * 返回 { design, impl }：按行首 【功能】/【实现】（兼容全角/半角冒号、无冒号）切分；
 * 旧单段 note（无【功能】前缀）整段归入 design、impl 为空；空 note 两段均为空。
 * 渲染剪裁（折叠卡 / 概览行只显功能段）与任务书 / 对话框拆分都从这里读，避免各处重复 split。 */
function devNoteParts(note) {
  const src = String(note || "").trim();
  if (!src) return { design: "", impl: "" };
  const impl = src.match(/(?:^|\n)\s*【实现】\s*[:：]?\s*([\s\S]*)$/);
  const design = (impl ? src.slice(0, impl.index) : src)
    .replace(/^\s*【功能】\s*[:：]?\s*/, "")
    .trim();
  return { design, impl: impl ? impl[1].trim() : "" };
}
/* 面向展示的两段式文本：两段齐全时带标签分行（tooltip 用）；只有单段时原样返回（不加标签） */
function devNoteDisplayText(note) {
  const p = devNoteParts(note);
  if (!p.design && !p.impl) return "";
  if (!p.impl) return p.design;
  return (
    I18n.t("模块功能（面向非技术）：") +
    (p.design || I18n.t("（暂无）")) +
    "\n" +
    I18n.t("实现要点（面向技术）：") +
    p.impl
  );
}
/* 对话框 note 字段：一项两行（功能段 + 实现段），供「建议 / 开发 / 细化」弹窗复用 */
function devNoteDialogField(node, label) {
  const p = devNoteParts(node && node.note);
  return { label: label || I18n.t("模块概述"), design: p.design, impl: p.impl };
}

/* ---------- 开发节点对话框草稿（用户输入不白写） ----------
 * 需求：在功能块点「开发 / 细化 / 建议 / 问询」写好一段内容后，因取消、Esc、
 *      或被别的事务顶出对话框（同一弹窗宿主会被后开的框接管）而丢光输入，
 *      用户只能从头再敲一遍。
 * 做法：mtDialogForm 每次输入都回调 devDraftSet()，按用途存进 node.devDraft
 *      （随工作流自动落盘，切画布 / 重启也在）；再次打开同一个框回填 + 提示可清空；
 *      只有真正提交（开始开发 / 确认细化 / 生成建议 / 开始问询）才清掉草稿。 */
const DEV_DRAFT_MAX = 20000; /* 单份草稿上限，防止超长粘贴把存档撑大 */
function devDraftOf(node, field) {
  const d = node && node.devDraft;
  if (!d || typeof d !== "object" || Array.isArray(d)) return "";
  return typeof d[field] === "string" ? d[field] : "";
}
function devDraftSet(node, field, text) {
  if (!node || !field) return;
  let t = String(text == null ? "" : text);
  if (t.length > DEV_DRAFT_MAX) t = t.slice(0, DEV_DRAFT_MAX);
  if (devDraftOf(node, field) === t) return;
  if (
    !node.devDraft ||
    typeof node.devDraft !== "object" ||
    Array.isArray(node.devDraft)
  )
    node.devDraft = {};
  if (t.trim()) node.devDraft[field] = t;
  else delete node.devDraft[field];
  /* 走常规防抖保存：停手后一次落盘，不逐键写盘 */
  scheduleSave();
}
/* 草稿 → mtDialogForm 的 textarea 参数（带内容时打上「已恢复」提示标记） */
function devDraftTextareaOpts(node, field, base) {
  const draft = devDraftOf(node, field);
  return Object.assign({}, base || {}, {
    value: draft || String((base && base.value) || ""),
    draft: !!draft.trim(),
  });
}

/* ---------- 进度上下文（喂给 AI 的「当前开发进度」） ---------- */
function devNodeBriefLine(n, mark) {
  const dk = devKindOf(n) || "module";
  const design = devNoteParts(n && n.note).design;
  return (
    (mark || "  - ") +
    (n.title || n.id) +
    "（" +
    I18n.t(DEV_KIND_LABEL[dk] || "模块") +
    " · " +
    devStatusText(devStatusOf(n)) +
    "）" +
    (design ? "：" + clipStr(design, 120) : "")
  );
}
/* 从顶层到本节点的祖先链（不含自身） */
function devAncestorChain(node) {
  const out = [];
  let cur = node && node.parentSuperId ? nodeById(node.parentSuperId) : null;
  let guard = 0;
  while (cur && guard++ < 32) {
    out.unshift(cur);
    cur = cur.parentSuperId ? nodeById(cur.parentSuperId) : null;
  }
  return out;
}
/* 全画布开发进度：让 AI 知道整个项目走到哪一步，才谈得上「下一步」 */
function devProgressOverviewText(node) {
  if (!S.wf) return "";
  const all = (S.wf.nodes || []).filter((n) => n.kind === "super" && n.dev && !n.db);
  if (!all.length) return "";
  const done = all.filter((n) => devStatusOf(n) === "done").length;
  const wip = all.filter((n) => devStatusOf(n) === "wip").length;
  const lines = [
    I18n.t("共 ") +
      all.length +
      I18n.t(" 个功能块：已完成 ") +
      done +
      " · " +
      I18n.t("进行中 ") +
      wip +
      " · " +
      I18n.t("待开发 ") +
      Math.max(0, all.length - done - wip),
  ];
  /* 整棵功能块树（缩进表示层级，* = 本次要评估的块）：AI 只有看到全局才知道「下一步」该往哪走 */
  const isTop = (n) => !n.parentSuperId || all.indexOf(nodeById(n.parentSuperId)) < 0;
  let used = 0;
  let cut = 0;
  const walk = (parent, depth) => {
    const kids = all.filter((n) => (parent ? n.parentSuperId === parent.id : isTop(n)));
    for (const k of kids) {
      if (used >= 40) {
        cut++;
        continue;
      }
      used++;
      lines.push(
        devNodeBriefLine(
          k,
          (k.id === (node && node.id)
            ? "* "
            : new Array(depth + 1).join("  ") + "- "),
        ),
      );
      walk(k, depth + 1);
    }
  };
  walk(null, 0);
  if (cut)
    lines.push("  … " + I18n.t("其余 ") + cut + I18n.t(" 个功能块未列出"));
  return lines.join("\n");
}
/* 该块历史会话（最近的要求 + 汇报）：当前进度最直接的证据 */
function devSessionDigestText(node) {
  const all = devSessionsOf(node);
  const list = all.slice(0, 3);
  if (!list.length)
    return I18n.t("（该功能块还没有开发 / 细化会话 · 说明还没真正动过手）");
  const lines = [];
  list.forEach((s, i) => {
    const msgs = (s.messages || []).filter((m) => m && !m._src && m.content);
    let lastUser = "";
    let lastAi = "";
    for (let k = msgs.length - 1; k >= 0; k--) {
      const t = String(msgs[k].content || "").trim();
      if (!t) continue;
      if (!lastAi && msgs[k].role === "assistant") lastAi = t;
      else if (!lastUser && msgs[k].role === "user") lastUser = t;
      if (lastAi && lastUser) break;
    }
    /* 合并后的单条任务书会话（首轮只有 _src:"dev-node" 一条）：从「本次开发需求：」行还原要求 */
    if (!lastUser && typeof devReqTextOfMessage === "function") {
      const req = devReqTextOfMessage((s.messages || [])[0]);
      if (req) lastUser = req;
    }
    lines.push(
      (i === 0 ? I18n.t("最近一次会话") : I18n.t("更早会话")) +
        "「" +
        (s.title || "") +
        "」" +
        (Number(s.updatedAt) ? " · " + devSuggestStamp(s.updatedAt) : ""),
    );
    if (lastUser) lines.push("  " + I18n.t("要求：") + clipStr(lastUser, 260));
    if (lastAi) lines.push("  " + I18n.t("汇报：") + clipStr(lastAi, 260));
  });
  if (all.length > list.length)
    lines.push(
      I18n.t("（另有 ") + (all.length - list.length) + I18n.t(" 个更早会话未列出）"),
    );
  return lines.join("\n");
}
/* 「细化深度」现状一行（统计函数 devDepthSummaryText 住在 app.js；缺省时留空不阻塞调研） */
function devDepthLineOf(node) {
  return typeof devDepthSummaryText === "function"
    ? devDepthSummaryText(node)
    : "";
}
function devSuggestContextText(node, focus) {
  const dk = devKindOf(node) || "module";
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  const parent = node.parentSuperId ? nodeById(node.parentSuperId) : null;
  const sibs = parent ? devChildrenOf(parent).filter((k) => k.id !== node.id) : [];
  const chain = devAncestorChain(node);
  const lines = [];
  lines.push(
    I18n.t("目标功能块：") +
      (node.title || I18n.t("未命名模块")) +
      "（" +
      I18n.t(DEV_KIND_LABEL[dk] || "模块") +
      " · " +
      devStatusText(devStatusOf(node)) +
      "）",
  );
  const noteParts = devNoteParts(node && node.note);
  lines.push(
    I18n.t("模块功能（面向非技术）：") +
      (noteParts.design || I18n.t("（暂无 · 该块在业务上做什么、给谁用还没写清楚）")),
  );
  lines.push(
    I18n.t("实现要点（面向技术）：") +
      (noteParts.impl || I18n.t("（暂无 · 实现方案梗概待补）")),
  );
  lines.push(
    I18n.t("项目根目录：") + (p || I18n.t("（未设置 · 请以会话工作区为项目根）")),
  );
  if (chain.length) {
    lines.push(I18n.t("所属上层链路："));
    chain.forEach((a, i) => {
      lines.push(
        "  ".repeat(i + 1) + (a.title || a.id) + "（" + devStatusText(devStatusOf(a)) + "）",
      );
    });
  }
  if (sibs.length) {
    lines.push(
      I18n.t("同层兄弟块（共 ") + (sibs.length + 1) + I18n.t(" 个，本块不在内）：",
      ),
    );
    for (const s of sibs.slice(0, 14)) lines.push(devNodeBriefLine(s));
    if (sibs.length > 14)
      lines.push("  … " + I18n.t("其余 ") + (sibs.length - 14) + I18n.t(" 个"));
  }
  const depthTxt = devDepthLineOf(node);
  if (depthTxt)
    lines.push(I18n.t("细化深度现状（细化＝深度，非本层展开数量）：") + depthTxt);
  lines.push(I18n.t("本块已有下层元素（共 ") + kids.length + I18n.t(" 个）："));
  if (!kids.length) lines.push("  " + I18n.t("（无 · 尚未细化到文件 / 类）"));
  for (const k of kids.slice(0, 30)) lines.push(devNodeBriefLine(k));
  if (kids.length > 30)
    lines.push("  … " + I18n.t("其余 ") + (kids.length - 30) + I18n.t(" 个"));
  lines.push(I18n.t("画布上的开发进度总览（* 为本块）："));
  lines.push(devProgressOverviewText(node) || "  " + I18n.t("（无）"));
  lines.push(I18n.t("本块的历史开发会话："));
  lines.push(devSessionDigestText(node));
  const cached = devSuggestOf(node);
  if (cached) {
    lines.push(
      I18n.t("上一次 AI 建议（请依据最新现状重评，不要照抄）："),
    );
    for (const it of cached.items)
      lines.push("  - " + it.title + (it.desc ? "：" + clipStr(it.desc, 80) : ""));
  }
  const f = String(focus || "").trim();
  if (f) lines.push(I18n.t("用户本轮指定的关注点：") + f);
  return lines.join("\n");
}

/* ---------- 任务书与系统提示 ---------- */
function devSuggestSystemPrompt() {
  return [
    "你是 MTNode「开发节点」的进度评估器：只做只读调研并给出方案，绝不实施。",
    "禁止：创建 / 修改 / 删除任何文件（write、edit、str_replace_editor）；执行任何有副作用的命令（安装、删除、移动、复制、构建、git commit/checkout、重启服务、清理目录）；调用 mtnode_canvas_edit / mtnode_app 的修改类动作；用 todo_write 登记执行清单；用 create_goal 立执行目标；用 subagent 派生实现工作。",
    "允许并鼓励只读调研：read、glob、grep、只读命令（git status / git log / git diff --stat / node --check / ls）、mtnode_canvas_get、web_search。",
    "纪律：结论必须来自你真实读到的代码，引用具体文件路径（能带行号更好）；查不到就直说，禁止臆测或用通用最佳实践凑数。",
    "共识：若项目根目录存在 AGENTS.md（Agent 共识文件），先读它并严格遵守其中的「目录约定」与「不要修改」清单；任何方案都不得触碰清单内路径。",
    "输出纪律：最后一条消息只输出一个 JSON 对象，前后不要任何文字、解释或 markdown 代码块。",
    'JSON 契约：{"summary":"≤80字：该模块当前真实进度与最大缺口","basis":["证据：文件路径(:行号) + 一句话","…"],"options":[{"title":"≤24字方案名","desc":"≤90字：做什么 + 为什么 + 涉及哪些文件","priority":"high|mid|low"}]}',
    "options 必须恰好 " +
      DEV_SUGGEST_COUNT +
      " 条，按推荐程度从高到低排列；每条都能独立开工、彼此不重复（用户会多选组合后一起交给开发）；basis 给 3~5 条真实证据。",
  ].join("\n");
}
function devSuggestPrompt(node, focus) {
  const lines = [];
  lines.push(
    I18n.t(
      "【建议任务】请依据项目真实代码与该模块的开发进度，评估这个功能块下一步应该实现哪些内容。",
    ),
  );
  lines.push("");
  lines.push(devSuggestContextText(node, focus));
  lines.push("");
  lines.push(I18n.t("请按以下步骤工作："));
  lines.push(
    "1. " +
      I18n.t(
        "摸清现状：目录结构、依赖清单、入口与构建 / 测试脚本，以及与本模块职责直接相关的源码文件（用 glob / grep 定向取证，不要全量读源码）。",
      ),
  );
  lines.push(
    "2. " +
      I18n.t(
        "对照该块概述的【实现】段判断真实完成度：哪些职责已落地、哪些缺失或是半成品（TODO / 空实现 / 未接线的调用 / 缺错误处理 / 无测试）；再用【功能】段核对职责是否偏离。",
      ),
  );
  lines.push(
    "3. " +
      I18n.t(
        "给出恰好 " +
          DEV_SUGGEST_COUNT +
          " 条下一步方案：具体到能直接开工（写明要改 / 新增的文件与接口），彼此独立可组合，并尽量覆盖不同层面（功能补全 / 健壮性与测试 / 与相邻模块接线 / 重构与文档）。",
      ),
  );
  lines.push(
    "4. " +
      I18n.t(
        "若本模块其实已经完备，不要硬凑新功能：改为给出「下一步该做什么」（如按深度继续细化——把子块逐层下钻到文件 / 类级、集成验证、性能与边界、补概述与文档），并在 summary 里说明现状。",
      ),
  );
  lines.push(
    "5. " +
      I18n.t(
        "若用户指定了关注点，优先围绕它给方案；但发现更要紧的问题也要占一条，并在 desc 里说明理由。",
      ),
  );
  lines.push(
    "6. " +
      I18n.t(
        "若项目根目录存在 AGENTS.md（Agent 共识文件），先读并遵守：新文件按「目录约定」放置；「不要修改」清单内的路径一律不得建议改动。",
      ),
  );
  lines.push("");
  lines.push(I18n.t("现在开始只读调研；完成后只输出那个 JSON 对象。"));
  return lines.join("\n");
}

/* ---------- 契约解析 ---------- */
/* 从一堆文本里抠出第一个能 parse 的 JSON 对象（容忍前后杂文 / 代码块） */
function devSuggestExtractJson(text) {
  const s = String(text || "");
  let start = s.indexOf("{");
  let guard = 0;
  while (start >= 0 && guard++ < 40) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(start, i + 1));
            if (o && typeof o === "object" && !Array.isArray(o)) return o;
          } catch (_) {}
          break;
        }
      }
    }
    start = s.indexOf("{", start + 1);
  }
  return null;
}
function devSuggestSplitTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{2,30}?)\s*(?:——|—|–|\|{1,2}|::)\s*(.+)$/);
  if (m && String(m[2] || "").length > 8) return { title: m[1].trim(), desc: m[2].trim() };
  return { title: t, desc: "" };
}
function devSuggestItemOf(el, idx) {
  let title = "";
  let desc = "";
  let pri = "mid";
  let priRaw = "";
  if (typeof el === "string") {
    title = el;
  } else if (el && typeof el === "object") {
    title = String(
      el.title || el.label || el.name || el.plan || el["方案"] || el["标题"] || "",
    ).trim();
    desc = String(
      el.desc ||
        el.detail ||
        el.description ||
        el.hint ||
        el.reason ||
        el["说明"] ||
        el["描述"] ||
        "",
    ).trim();
    priRaw = String(
      el.priority || el.level || el.prio || el["优先级"] || el["级别"] || "",
    );
    pri = devSuggestPriorityOf(priRaw);
  }
  /* 优先级若写在标题里（「【优先】xxx」「高优先：xxx」「high - xxx」），解析出来并剥掉标记 */
  if (!String(priRaw || "").trim()) {
    let lead = "";
    let rest = title;
    const bracket = title.match(/^[【[(（]([^】\])）]{1,8})[】\])）]\s*(.*)$/);
    if (bracket) {
      lead = bracket[1];
      rest = bracket[2];
    } else {
      const word = title.match(
        /^(高优先|高必要|高优|高|优先|紧急|必要|中优先|中|常规|一般|低优先|低优|低|延后|可延后|可选|p0|p1|p2|p3|high|medium|mid|low|urgent|critical|nice)(?:级|度)?\s*(?:[::、）)—\-|]\s*|\s+)([\s\S]+)$/i,
      );
      if (word) {
        lead = word[1];
        rest = word[2];
      }
    }
    if (
      lead &&
      /高|优先|紧急|必要|中|常规|一般|低|延后|可选|p\d|high|medium|mid|low|urgent|critical|nice/i.test(
        lead,
      )
    ) {
      pri = devSuggestPriorityOf(lead);
      title = rest.trim();
    }
  }
  title = title.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!desc) {
    const sp = devSuggestSplitTitle(title);
    title = sp.title;
    desc = sp.desc;
  }
  title = title.replace(/^[-*•\d.、)\]\s]+/, "").trim().slice(0, 80);
  if (!title) return null;
  return {
    id: "o" + (idx + 1),
    title,
    desc: desc.replace(/\s+/g, " ").trim().slice(0, 500),
    priority: pri,
  };
}
/* 兜底：模型没给 JSON 时，从「1. 标题 —— 说明」这类列表里抠方案 */
function devSuggestParseLines(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = String(raw || "").trim();
    if (!line || line.length < 6) continue;
    if (/^[{}[\]`]+$/.test(line)) continue;
    if (/^(summary|basis|options|note)\b/i.test(line)) continue;
    if (/^(依据|证据|总结|方案[::：]?$)/.test(line)) continue;
    line = line.replace(/^#+\s*/, "");
    const numbered =
      line.match(/^(\d+)[.、)）]\s*(.+)$/) || line.match(/^[-*•]\s*(.+)$/);
    if (!numbered) continue;
    const body = String(numbered[numbered.length === 3 ? 2 : 1] || "").trim();
    /* 行首优先级标记（【优先】/ 高优先：/ high -）统一交给 devSuggestItemOf 解析并剥离 */
    const it = devSuggestItemOf(body, out.length);
    if (it) out.push(it);
    if (out.length >= DEV_SUGGEST_COUNT) break;
  }
  return out;
}
/* 建议契约解析 → {at, summary, basis, items[≤4]} 或 null */
function devSuggestParse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let summary = "";
  let basis = [];
  let items = [];
  const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const sources = fence ? [fence[1], raw] : [raw];
  for (const src of sources) {
    const obj = devSuggestExtractJson(src);
    if (!obj) continue;
    const arr = obj.options || obj.items || obj.suggestions || obj.plans || obj["方案"];
    const got = [];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length && got.length < DEV_SUGGEST_COUNT; i++) {
        const it = devSuggestItemOf(arr[i], got.length);
        if (it) got.push(it);
      }
    }
    if (got.length < 2) continue;
    items = got;
    summary = String(
      obj.summary || obj.overview || obj["总结"] || obj["现状"] || "",
    ).trim();
    const b = obj.basis || obj.evidence || obj["依据"] || obj["证据"];
    if (Array.isArray(b))
      basis = b
        .map((x) =>
          typeof x === "string"
            ? x
            : String((x && (x.text || x.file || x.path || x.evidence)) || ""),
        )
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 6);
    break;
  }
  if (items.length < 2) {
    items = devSuggestParseLines(raw);
    summary = "";
    basis = [];
  }
  if (items.length < 2) return null;
  const rank = { high: 0, mid: 1, low: 2 };
  const order = {};
  items.forEach((it, i) => {
    order[it.id] = i;
  });
  items = items
    .slice(0, DEV_SUGGEST_COUNT)
    .sort((a, b) => (rank[a.priority] || 0) - (rank[b.priority] || 0) || order[a.id] - order[b.id]);
  return { at: Date.now(), summary: summary.slice(0, 500), basis, items };
}
/* 勾选结果 + 补充 → 「开发」按钮要用的任务正文 */
function devSuggestBriefText(node, sug, pickedIds, supplement) {
  const ids = Array.isArray(pickedIds) ? pickedIds : [];
  const all = (sug && sug.items) || [];
  const picked = all.filter((it) => ids.indexOf(it.id) >= 0);
  const rest = all.filter((it) => ids.indexOf(it.id) < 0);
  const extra = String(supplement || "").trim();
  const lines = [];
  lines.push(
    I18n.t("【按「建议」确认的方案开发】") +
      " " +
      (node.title || I18n.t("开发节点")) +
      "（" +
      I18n.t(DEV_KIND_LABEL[devKindOf(node) || "module"] || "模块") +
      "）",
  );
  if (sug && sug.summary) lines.push(I18n.t("AI 评估：") + sug.summary);
  if (picked.length) {
    lines.push(
      I18n.t("用户已勾选 ") +
        picked.length +
        " / " +
        all.length +
        I18n.t(" 条方案，本轮要实现："),
    );
    picked.forEach((it, i) => {
      lines.push(
        "  " +
          (i + 1) +
          ". [" +
          devSuggestPriorityText(it.priority) +
          "] " +
          it.title +
          (it.desc ? " —— " + it.desc : ""),
      );
    });
  } else {
    lines.push(I18n.t("用户未采纳 AI 提议的方案，按下述补充要求开发："));
  }
  if (rest.length)
    lines.push(
      I18n.t("本轮明确不做：") +
        rest.map((r) => r.title).join("、") +
        I18n.t("（除非实施中发现它是所选项的必要前提，此时先说明理由）"),
    );
  if (extra) lines.push(I18n.t("用户补充：") + extra);
  lines.push("");
  lines.push(
    I18n.t(
      "实施要求：以项目根目录内的真实代码为准；上述方案若与现状冲突，先说清取舍再动手；每完成一项做一次可验证检查（构建 / 运行 / 测试 / 只读命令）。",
    ),
  );
  lines.push(
    I18n.t(
      "共识：若项目根目录有 AGENTS.md，先读并遵守（目录约定 / 不要修改清单），新文件按约定放置。",
    ),
  );
  lines.push(
    I18n.t(
      "完成后按两段式规范（【功能】非技术说明 + 【实现】工程梗概）回写该开发节点的概述（note），并更新状态（devStatus），用一句话汇报改了什么。",
    ),
  );
  return lines.join("\n");
}

/* ---------- 对话框公共小工具（复用 #mtDialog 深色宿主，与「开发 / 细化」同风格） ---------- */
function devDlgOpen(host, cls) {
  const box = host.querySelector(".mt-dialog-box");
  if (box) {
    box.classList.add("mt-form-box");
    box.classList.add("mt-form-wide");
    if (cls) box.classList.add(cls);
  }
  return box;
}
function devDlgClose(host, box, cls) {
  closeMtDialog();
  if (box) {
    box.classList.remove("mt-form-box");
    box.classList.remove("mt-form-wide");
    if (cls) box.classList.remove(cls);
  }
}
function devDlgEl(tag, cls, txt) {
  const el = document.createElement(tag || "div");
  if (cls) el.className = cls;
  if (txt != null) el.textContent = String(txt);
  return el;
}
function devDlgBtn(a) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = a.primary ? "mini primary" : a.danger ? "mini danger" : "mini";
  b.textContent = a.label || a.id;
  if (a.title) b.title = a.title;
  b.onclick = () => a.run();
  return b;
}
/* 方案清单 + 补充框 +「取消 / 换一批(可选) / 开发」；返回 {picked, supplement} */
function devSuggestPickBody(host, opts) {
  const sug = opts.suggestion;
  const frag = document.createDocumentFragment();
  if (sug.summary) {
    const nb = devDlgEl("div", "mt-form-note");
    const iEl = devDlgEl("i", null, I18n.t("AI 评估") + (sug.at ? " · " + devSuggestStamp(sug.at) : ""));
    const pEl = devDlgEl("p", null, sug.summary);
    nb.appendChild(iEl);
    nb.appendChild(pEl);
    frag.appendChild(nb);
  }
  if (sug.basis && sug.basis.length) {
    const lb = devDlgEl("div", "mt-form-list");
    lb.appendChild(devDlgEl("i", null, I18n.t("依据（AI 真实读到的代码）")));
    const ul = devDlgEl("div");
    for (const b of sug.basis) ul.appendChild(devDlgEl("span", "mt-form-li", b));
    lb.appendChild(ul);
    frag.appendChild(lb);
  }
  frag.appendChild(
    devDlgEl(
      "label",
      "mt-form-lab",
      I18n.t("下一步方案（可多选 · 数字键 1-") +
        sug.items.length +
        I18n.t(" 快速勾选）"),
    ),
  );
  const list = devDlgEl("div", "mt-sug-opts");
  sug.items.forEach((it, i) => {
    const row = devDlgEl("label", "mt-sug-opt pr-" + it.priority);
    if (opts.picked[it.id]) row.classList.add("on");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!opts.picked[it.id];
    cb.onchange = () => {
      opts.picked[it.id] = cb.checked;
      row.classList.toggle("on", cb.checked);
      const e = list.parentElement
        ? list.parentElement.querySelector(".mt-form-err")
        : null;
      if (e) e.hidden = true;
      if (opts.onPick) opts.onPick(it, cb.checked);
    };
    row.appendChild(cb);
    row.appendChild(devDlgEl("span", "mt-sug-no", String(i + 1)));
    const txt = devDlgEl("div", "mt-sug-txt");
    const head = devDlgEl("div", "mt-sug-head");
    head.appendChild(devDlgEl("b", "mt-sug-title", it.title));
    head.appendChild(devDlgEl("span", "mt-sug-pri pr-" + it.priority, devSuggestPriorityText(it.priority)));
    txt.appendChild(head);
    if (it.desc) txt.appendChild(devDlgEl("div", "mt-sug-desc", it.desc));
    row.appendChild(txt);
    list.appendChild(row);
  });
  frag.appendChild(list);
  frag.appendChild(
    devDlgEl("label", "mt-form-lab", I18n.t("补充说明（可选 · 会一起交给开发会话）")),
  );
  const ta = document.createElement("textarea");
  ta.className = "mt-form-input";
  ta.rows = Number(opts.taRows || 4);
  ta.placeholder = opts.placeholder || I18n.t("例如：第 2 条顺便把超时改成可配置；先做最小可运行版本；不要改对外 API…");
  ta.value = String(opts.supplement || "");
  /* 边写边回报：本框任何一次重绘（数字键勾选、换一批、校验报错）都不该吞掉用户已写的内容 */
  ta.addEventListener("input", () => {
    if (typeof opts.onSupplement === "function")
      opts.onSupplement(String(ta.value || ""));
  });
  frag.appendChild(ta);
  const errP = devDlgEl("p", "mt-form-err", opts.err || "");
  errP.hidden = !opts.err;
  frag.appendChild(errP);
  frag.appendChild(
    devDlgEl(
      "p",
      "mt-form-hint",
      opts.hint ||
        I18n.t(
          "点「开发」= 用当前勾选的方案 + 补充说明，新建该模块的开发会话并直接开工（与「开发」按钮同一条路径，只是内容已替你写好）· 数字键勾选 · Ctrl+Enter 开发 · Esc 取消",
        ),
    ),
  );
  const bodyEl = host.querySelector("#mtDlgBody");
  if (bodyEl) {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(frag);
  }
  const footEl = host.querySelector("#mtDlgFoot");
  if (footEl) {
    footEl.innerHTML = "";
    footEl.appendChild(
      devDlgBtn({ label: I18n.t("取消"), run: () => opts.onCancel() }),
    );
    if (opts.onRegen)
      footEl.appendChild(
        devDlgBtn({
          label: I18n.t("换一批"),
          title: I18n.t("重新让 AI 评估一轮（覆盖当前方案）"),
          run: () => opts.onRegen(),
        }),
      );
    footEl.appendChild(
      devDlgBtn({
        label: I18n.t("开发"),
        primary: true,
        title: I18n.t("用当前勾选的方案与补充内容开始开发"),
        run: () =>
          opts.onDev(
            sug.items.filter((it) => opts.picked[it.id]).map((it) => it.id),
            String(ta.value || "").trim(),
          ),
      }),
    );
  }
  return { ta };
}

/* ============ 「建议」结果写入记录会话（避免内容只留在弹窗里而丢失） ============
 * 需求：开发节点的「建议」AI 评估只显示在弹窗里——结果虽缓存到 node.devSuggest
 * （随工作流保存），但不出现在任何会话中。
 * 做法：记入一个归属该功能块的「记录会话」（建议 · 模块名），与开发 / 细化绑定会话
 * 一样随会话列表持久化落盘，随时可回溯。
 * 记录会话只存档、不参与绑定会话的「运行 / 停止」语义：id 记在节点字段
 * node.devSuggestSessionId 上，不进 devSessionIds。
 * 消息带 _src:"dev-record" 标记，避免被「最近一次要求 / 绑定会话首条任务书」
 * 等只认 _src:"dev-node" 的逻辑误判。
 * 注：「问询」过去也靠这套补写留档（回答只活在 devAskJobs 内存作业里，弹窗被顶掉
 * 就再也看不到）；现在问询直接跑在该功能块的只读会话里（app.js startDevAskSession），
 * 问答天然持久化，无需补写，故「问询记录会话」这一路随作业链一并废弃。
 */
function devSuggestRecordTitleOf(node) {
  return I18n.t("建议") + " · " + (node.title || I18n.t("开发节点"));
}
/* 取（或新建）该功能块的建议记录会话：节点字段优先，其次按标题找（节点改名后兜底） */
function devSuggestRecordSessionOf(node) {
  if (!node || node.kind !== "super" || !node.dev) return null;
  const list = agentSessions();
  let sess = null;
  if (node.devSuggestSessionId)
    sess = list.find((s) => s && s.id === node.devSuggestSessionId) || null;
  if (!sess) {
    const wantTitle = devSuggestRecordTitleOf(node);
    sess = list.find((s) => s && s.title === wantTitle) || null;
  }
  if (!sess) {
    sess = {
      id: uid("as"),
      title: devSuggestRecordTitleOf(node),
      workspace:
        devPathOf(node) ||
        (typeof dshWorkspaceOf === "function" ? dshWorkspaceOf(node) : ""),
      preset: AGENT_PRESET_DEFAULT,
      provider: "deepseek-official",
      model: "",
      effort: "high",
      messages: [],
      archived: false,
      updatedAt: Date.now(),
    };
    list.unshift(sess);
  }
  if (node.devSuggestSessionId !== sess.id) node.devSuggestSessionId = sess.id;
  return sess;
}
/* 记录会话持久化 + 会话列表即时可见（消息已入 S.agentSessions，fire-and-forget 落盘） */
function devRecordSessionFlush() {
  try {
    if (typeof persistAgentSession === "function") persistAgentSession();
  } catch (_) {}
  try {
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  } catch (_) {}
  if (typeof scheduleSave === "function") scheduleSave(true);
}
/* 「建议」AI 评估 → 建议会话（assistant 消息；同正文不重复写） */
function devSuggestRecordText(node, sug) {
  const lines = [];
  lines.push(
    I18n.t("【AI 建议评估】") +
      " · " +
      (node.title || I18n.t("开发节点")) +
      (sug.at ? " · " + devSuggestStamp(sug.at) : ""),
  );
  if (sug.summary) lines.push(I18n.t("AI 评估：") + sug.summary);
  sug.items.forEach((it, i) => {
    lines.push(
      (i + 1) +
        ". [" +
        devSuggestPriorityText(it.priority) +
        "] " +
        it.title +
        (it.desc ? " —— " + it.desc : ""),
    );
  });
  if (Array.isArray(sug.basis) && sug.basis.length) {
    lines.push(I18n.t("依据（AI 真实读到的代码）") + "：");
    for (const b of sug.basis) lines.push("  · " + b);
  }
  return lines.join("\n");
}
function devSuggestRecordToSession(node, sug) {
  if (!node || !sug || !Array.isArray(sug.items) || !sug.items.length) return;
  const sess = devSuggestRecordSessionOf(node);
  if (!sess) return;
  const text = devSuggestRecordText(node, sug);
  const msgs = sess.messages || [];
  if (msgs.some((m) => m && m.role === "assistant" && m.content === text)) return;
  msgs.push({ role: "assistant", content: text, _src: "dev-record", at: Date.now() });
  sess.updatedAt = Date.now();
  devRecordSessionFlush();
}
/* 用户在方案清单里的勾选 + 补充 → 追加进建议会话（user 消息，决策不丢失） */
function devSuggestRecordPicked(node, ids, supplement) {
  if (!node) return;
  const sess = devSuggestRecordSessionOf(node);
  if (!sess) return;
  const sug = devSuggestOf(node);
  const all = (sug && sug.items) || [];
  const picked = all.filter((it) => ids.indexOf(it.id) >= 0);
  const extra = String(supplement || "").trim();
  const lines = [I18n.t("【本轮采纳】") + " · " + (node.title || I18n.t("开发节点"))];
  if (picked.length) {
    lines.push(I18n.t("用户已勾选 ") + picked.length + " / " + all.length + "：");
    picked.forEach((it, i) => {
      lines.push(
        "  " + (i + 1) + ". [" + devSuggestPriorityText(it.priority) + "] " + it.title,
      );
    });
  } else {
    lines.push(I18n.t("用户未采纳 AI 提议的方案，按下述补充要求开发："));
  }
  if (extra) lines.push(I18n.t("用户补充：") + extra);
  const text = lines.join("\n");
  const msgs = sess.messages || [];
  if (msgs.some((m) => m && m.role === "user" && m.content === text)) return;
  msgs.push({ role: "user", content: text, _src: "dev-record", at: Date.now() });
  sess.updatedAt = Date.now();
  devRecordSessionFlush();
}
/* 「问询」不再往会话里补写问答：它整轮就跑在自己的只读会话里（见 app.js startDevAskSession） */

/* ============ 建议调研 = 后台作业（运行态与对话框解耦） ============
 * 「建议」的只读调研不再绑在 devSuggestDialog 的生命周期上：运行态
 * （phase / lines / toolCount / elapsed / err / suggestion / picked / focus）
 * 外置到模块级注册表 devSuggestJobs，key = node.id（与 devSuggestRunKey(node)
 * 一一对应：一个 runKey 只有一个取消句柄，重复发起会互相覆盖，所以同一个功能块
 * 同一时刻绝不允许两轮调研；不同功能块 key 隔离，可以各跑各的）。
 * 于是对话框退化成一个「视图」：挂上就实时渲染，摘掉（关框 / 被别的弹窗顶掉）
 * 作业照旧推进，结果仍写回 node.devSuggest + scheduleSave(true)，切画布/保存不丢。
 * 生命周期：suggestDevNode（入口幂等）→ devSuggestJobRun（start）→
 * devSuggestJobSettle（then / catch 只写 job，不再走 alive()）→ 有视图就渲染、
 * 没视图就留在注册表等用户回来接。运行队列同步点也从对话框搬到作业
 * （start / settle / 出栈各同步一次，见 devSuggestQueueSync）。
 * 边界：节点被删除或已切到别的画布（wfId 不符）时，结算不报错——清作业 + 提示。
 * 注：作业只存在于渲染进程内存，不跨页面刷新 / 应用重启续跑。
 */
const devSuggestJobs = new Map();

function devSuggestJobKeyOf(node) {
  return String((node && node.id) || "");
}
/* 取该功能块的调研作业（可能为 null） */
function devSuggestJobOf(node) {
  return devSuggestJobs.get(devSuggestJobKeyOf(node)) || null;
}
/* 该块是否有「在途」调研（入口幂等据此决定：接管视图，而不是再发一轮） */
function devSuggestJobBusy(node) {
  const j = devSuggestJobOf(node);
  return j && j.running ? j : null;
}
/* 作业结算时还能不能落到节点上：返回当前画布里那个开发节点，取不到 = null。
   节点被删 / 已切到别的画布（wfId 不一致）都算取不到。 */
function devSuggestJobTarget(job) {
  if (!job) return null;
  const curWf = (typeof S !== "undefined" && S.wf && S.wf.id) || "";
  if (job.wfId && curWf && job.wfId !== curWf) return null;
  const node = typeof nodeById === "function" ? nodeById(job.nodeId) : job.node;
  if (!node || node.kind !== "super" || !node.dev) return null;
  return node;
}
/* 作业状态变化的唯一同步出口：左下角运行队列 + 画布折叠卡状态行
   （.n-dev-sugstate 两态行由 renderCanvas 重建）各同步一次。
   只读调研可「返回」后台跑，离开后画布是用户唯一的可见入口，必须实时跟上。 */
function devSuggestQueueSync() {
  if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
  if (typeof renderCanvas === "function") {
    try {
      renderCanvas();
    } catch (_) {}
  }
}
/* 通知挂载在本作业上的视图（没有视图 = 用户不在框内，静默） */
function devSuggestJobNotify(job, kind, arg) {
  const h = job && job.hooks;
  if (!h || typeof h[kind] !== "function") return;
  h[kind](arg);
}
/* 出栈：结果已在 node.devSuggest 上（或本轮被停止），注册表不必再留 */
function devSuggestJobDrop(job) {
  if (!job) return;
  if (job.timer) {
    clearInterval(job.timer);
    job.timer = null;
  }
  job.running = false;
  job.hooks = null;
  if (devSuggestJobs.get(job.id) === job) devSuggestJobs.delete(job.id);
  devSuggestQueueSync();
}
function devSuggestJobCreate(node, opts) {
  opts = opts || {};
  const id = devSuggestJobKeyOf(node);
  const prev = devSuggestJobs.get(id);
  if (prev) devSuggestJobDrop(prev);
  const job = {
    id,
    nodeId: id,
    wfId: (typeof S !== "undefined" && S.wf && S.wf.id) || "",
    node,
    focus: String(opts.focus || ""),
    /* run = 调研中 · options = 有方案可看 · failed = 这轮没拿到方案 */
    phase: "run",
    running: false,
    started: false,
    lines: [],
    toolCount: 0,
    startedAt: 0,
    elapsed: "0s",
    err: "",
    suggestion: null,
    picked: {},
    /* 用户是否真看过本轮方案清单：没看过 → 再点「建议」直接开清单，不重跑模型 */
    viewed: false,
    /* 用户是否已「返回」到后台（mt-sug-log 底部提示） ·
       结算时因宿主被占未能跳窗（该块「建议」按钮变成一键直达方案清单） */
    bg: false,
    ready: false,
    timer: null,
    hooks: null,
  };
  devSuggestJobs.set(id, job);
  return job;
}
function devSuggestJobAttach(job, hooks) {
  if (job) job.hooks = hooks || null;
}
/* 视图摘掉后：还在跑 / 跑完没被看过 → 留在注册表里等接回来；否则出栈 */
function devSuggestJobDetach(job, hooks) {
  if (!job) return;
  if (!hooks || job.hooks === hooks) job.hooks = null;
  if (job.running) return;
  if (job.phase === "options" && !job.viewed) return;
  devSuggestJobDrop(job);
}
function devSuggestJobLog(job, txt) {
  const t = String(txt || "").replace(/\s+/g, " ").trim();
  if (!t || job.phase !== "run") return;
  if (job.lines[job.lines.length - 1] === t) return;
  job.lines.push(t);
  while (job.lines.length > 200) job.lines.shift();
  devSuggestJobNotify(job, "log", t);
}
function devSuggestJobTick(job) {
  const sec = Math.round((Date.now() - job.startedAt) / 1000);
  job.elapsed =
    sec >= 60 ? Math.floor(sec / 60) + "m" + (sec % 60) + "s" : sec + "s";
  devSuggestJobNotify(job, "tick");
}
/* 用户显式「停止生成」：取消这一轮调研（离开对话框不等于停止） */
function devSuggestJobAbort(job) {
  if (!job || !job.running) return;
  job.running = false;
  try {
    dshCancelActive(devSuggestRunKey(job.node));
  } catch (_) {}
  /* 运行态立刻结束，不等心跳 */
  devSuggestQueueSync();
}
/* 从工具调用事件里抠出最有辨识度的一句参数（路径 / 模式）供进度日志显示 */
function devSuggestToolArg(data) {
  const rawArgs = data && data.args;
  if (typeof rawArgs === "string") {
    const hit = rawArgs.match(
      /"(?:file_path|path|pattern|query|command|include)"\s*:\s*"([^"]{1,160})"/i,
    );
    return hit ? hit[1] : rawArgs.slice(0, 120);
  }
  if (rawArgs && typeof rawArgs === "object") {
    return String(
      rawArgs.file_path ||
        rawArgs.path ||
        rawArgs.pattern ||
        rawArgs.query ||
        rawArgs.include ||
        rawArgs.command ||
        "",
    ).slice(0, 120);
  }
  return "";
}
/* ---- 发起一轮只读调研：只写 job，不假设有人在看着它 ---- */
function devSuggestJobRun(job) {
  if (!job || job.running) return;
  const node = job.node;
  const sup = typeof dshSupported === "function" ? dshSupported() : { ok: false };
  job.phase = "run";
  job.started = true;
  job.lines = [];
  job.err = "";
  job.toolCount = 0;
  job.bg = false;
  job.ready = false;
  job.startedAt = Date.now();
  job.elapsed = "0s";
  /* 先置 running 再通知：进度态的按钮要直接是「停止生成」 */
  job.running = true;
  devSuggestJobNotify(job, "render");
  /* 本功能块进入「建议（只读调研）运行态」：左下角运行队列同步一次 */
  devSuggestQueueSync();
  if (!sup.ok) {
    job.running = false;
    job.err = sup.reason || I18n.t("智能能力不可用");
    job.phase = "failed";
    devSuggestJobNotify(job, "render");
    devSuggestQueueSync();
    return;
  }
  devSuggestJobLog(
    job,
    I18n.t("开始只读调研（不改文件、不改画布）· 项目根：") +
      (devPathOf(node) || I18n.t("（未设置 · 用默认工作区）")),
  );
  if (job.timer) clearInterval(job.timer);
  job.timer = setInterval(() => devSuggestJobTick(job), 1000);
  /* 真正向引擎发起只读调研的这一刻再同步一次队列（上面可能已因不可用提前退出） */
  devSuggestQueueSync();
  /* 本功能块（或就近上层功能块）选定的 Agent 设定：只读调研也照用。
     模型 / 预设 / 思考档各自就近继承，三者可能来自不同的上层功能块，
     所以日志逐项点名（继承时带上来源块），否则只知道模型看不出这轮怎么跑。 */
  const eff = devAgentModelOf(node);
  const st = devAgentSettingsOf(node);
  const roundSegs = [];
  if (st.model)
    roundSegs.push(
      devAgentRouteName(st.provider) +
        " · " +
        st.model +
        devInheritSuffix(st.source, node),
    );
  if (st.preset)
    roundSegs.push(devPresetName(st.preset) + devInheritSuffix(st.presetSource, node));
  /* 思考档只在真被选过时点名：预设不决定思考档（不再压档），列出来会误导 */
  if (st.effort)
    roundSegs.push(
      devEffortName({ effort: st.effort }) + devInheritSuffix(st.effortSource, node),
    );
  if (roundSegs.length)
    devSuggestJobLog(job, I18n.t("本轮：") + roundSegs.join(" · "));
  dshRunTask(devSuggestPrompt(node, job.focus), {
    workspace: devPathOf(node) || "",
    runKey: devSuggestRunKey(node),
    preset: st.preset || AGENT_PRESET_DEFAULT,
    effort: st.effort || "high",
    provider: eff ? eff.provider : undefined,
    model: eff ? eff.model : undefined,
    systemPrompt: devSuggestSystemPrompt(),
    onEvent: (type, data) => {
      /* 视图在不在都照样记账：日志与调用次数属于作业，不属于 DOM */
      if (type === "tool" && data && data.name) {
        job.toolCount++;
        const arg = devSuggestToolArg(data);
        devSuggestJobLog(job, "🔧 " + data.name + (arg ? "  " + arg : ""));
        devSuggestJobNotify(job, "tick");
      } else if (type === "error" && data && data.message) {
        devSuggestJobLog(job, "⚠ " + data.message);
      }
    },
  })
    /* 用 then(onOk, onErr) 而不是 then().catch()：成功分支自己抛错时不应再被当成
       「模型报错」结算一遍（否则同一轮会被结算两次） */
    .then(
      (text) => devSuggestJobSettle(job, text, null),
      (err) =>
        devSuggestJobSettle(job, null, err || new Error("devsuggest run failed")),
    );
}
/* ---- 一轮调研结束：先写回 job / 节点，再通知视图（无视图则留在注册表等接回来） ---- */
function devSuggestJobSettle(job, text, err) {
  if (!job) return;
  if (job.timer) {
    clearInterval(job.timer);
    job.timer = null;
  }
  job.running = false;
  /* 调研结束（成功 / 失败 / 被停止）：运行态消失 → 队列同步 */
  devSuggestQueueSync();
  const cancelish =
    !!err &&
    typeof isCancelishError === "function" &&
    isCancelishError((err && err.message) || String(err));
  if (cancelish) {
    /* 用户主动停止：本轮没有结果可看 → 视图收尾 + 作业出栈（不打扰） */
    devSuggestJobNotify(job, "cancel");
    devSuggestJobDrop(job);
    return;
  }
  const target = devSuggestJobTarget(job);
  if (!target) {
    /* 节点已被删除 / 用户已切到别的画布：不报错，只静默清作业并提示一句 */
    devSuggestJobDrop(job);
    if (typeof toast === "function")
      toast(
        I18n.t("「") +
          ((job.node && job.node.title) || I18n.t("开发节点")) +
          I18n.t("」的调研已完成，但该功能块已不在当前画布，结果未写入。"),
        "warn",
      );
    return;
  }
  if (err) {
    job.phase = "failed";
    job.err = (err && err.message) || String(err);
    devSuggestJobNotify(job, "render");
    return;
  }
  const sug = devSuggestParse(text);
  if (!sug) {
    job.phase = "failed";
    job.err = I18n.t(
      "模型没有按契约返回方案。可以再试一次，或关掉本框改用「开发」按钮自己填写内容。",
    );
    devSuggestJobNotify(job, "render");
    return;
  }
  job.suggestion = sug;
  job.picked = {};
  job.picked[sug.items[0].id] = true;
  job.phase = "options";
  /* 结果落在节点上（与对话框开没开无关）：随工作流保存，切画布也不丢 */
  target.devSuggest = {
    at: sug.at,
    summary: sug.summary,
    basis: sug.basis,
    items: sug.items,
  };
  scheduleSave(true);
  /* AI 评估同步记入该功能块的「建议」会话：弹窗之外也能回溯，避免内容丢失 */
  devSuggestRecordToSession(target, sug);
  try {
    renderCanvas();
  } catch (_) {}
  /* 用户还在框内 → 就地渲染方案清单；已离开 → 自动重开对话框（宿主被占则只
     toast + 标 ready，该块「建议」按钮随即变成一键直达方案清单） */
  if (devSuggestJobViewAlive(job)) devSuggestJobNotify(job, "render");
  else devSuggestJobReopen(job);
}

/* ---- 可离开 + 完成跳窗（任务 2） ----
 * devSuggestJobViewAlive：当前是否还有「活着的」视图挂在作业上（用户仍在框内）。
 * devMtDialogOccupied：宿主正被别的弹窗占用（用户在填别的框 → 跳窗会冲掉输入）。
 * devSuggestJobReopen：作业结算而用户不在框内时：宿主空闲 → 自动重开对话框到
 *   phase=options（新 _mtDialogSeq 拿宿主）；宿主被占 → 只 toast + 标 ready，
 *   不打扰用户正在填的弹窗。 */
function devSuggestJobViewAlive(job) {
  return !!(
    job &&
    job.hooks &&
    typeof job.hooks.isAlive === "function" &&
    job.hooks.isAlive()
  );
}
function devMtDialogOccupied() {
  const host = document.getElementById("mtDialog");
  return !!(host && host.classList.contains("on"));
}
function devSuggestJobReopen(job) {
  if (!job || job.running || job.phase !== "options") return;
  if (devMtDialogOccupied()) {
    job.ready = true;
    if (typeof toast === "function")
      toast(
        I18n.t("「") +
          ((job.node && job.node.title) || I18n.t("开发节点")) +
          I18n.t(
            "」的建议已就绪。检测到你在填写其它窗口，未自动弹出；点该块的「建议」即可查看。",
          ),
        "ok",
      );
    return;
  }
  try {
    devSuggestShowJob(job);
  } catch (_) {}
}

/* ---------- 建议对话框入口（幂等：有在途作业就接管视图，不再发第二轮） ---------- */
function devSuggestDialog(node, opts) {
  opts = opts || {};
  let job = devSuggestJobOf(node);
  if (!job || (!job.running && !(job.phase === "options" && !job.viewed)))
    job = devSuggestJobCreate(node, opts);
  else if (opts.focus && !job.running) job.focus = String(opts.focus);
  return devSuggestShowJob(job);
}

/* ---------- 建议视图（挂到作业上：进度 → 就地变成方案清单） ---------- */
function devSuggestShowJob(job) {
  const node = job.node;
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const box = devDlgOpen(host, "mt-sug-box");
    const titleEl = host.querySelector("#mtDlgTitle");
    const bodyEl = host.querySelector("#mtDlgBody");
    /* 视图只保留「自己还活不活」与本框未提交的补充说明；运行态全在 job 上。
       supplement 初值：本轮关注点 → 上次留下的草稿（有则回填，取消/跳出都不丢） */
    const st = {
      settled: false,
      supplement: String(
        job.focus || devDraftOf(node, "supplement") || "",
      ),
    };
    let ta = null;
    let logEl = null;
    const alive = () => !st.settled && seq === _mtDialogSeq;
    const finish = (val) => {
      if (st.settled) return;
      st.settled = true;
      devSuggestJobDetach(job, hooks);
      host.removeEventListener("keydown", onKey);
      /* 宿主已被更新的弹窗接管 → 只摘自己的键盘监听，不去关别人的框 */
      if (seq === _mtDialogSeq) devDlgClose(host, box, "mt-sug-box");
      resolve(val || null);
    };
    const stampElapsed = () => {
      const el = host.querySelector("#mtSugElapsed");
      if (el)
        el.textContent =
          job.elapsed + " · " + job.toolCount + I18n.t(" 次只读工具调用");
    };
    /* 作业 → 视图的回调：状态由作业推进，DOM 只负责画 */
    const hooks = {
      render: () => render(),
      tick: () => stampElapsed(),
      cancel: () => finish(null),
      isAlive: () => alive(),
      log: (t) => {
        if (!alive() || job.phase !== "run" || !logEl) return;
        logEl.appendChild(devDlgEl("div", "mt-sug-log-row", t));
        while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      },
    };
    devSuggestJobAttach(job, hooks);
    /* 视图上的动作只是作业的薄封装：停止 = 显式取消本轮（离开不等于取消） */
    const abortRun = () => devSuggestJobAbort(job);
    const runOnce = () => devSuggestJobRun(job);
    /* 「返回」：只隐藏对话框（closeMtDialog），作业继续在后台跑，完成后自动弹出。
       与「停止生成」的区别：不碰 dshCancelActive，作业留在注册表里等结算 / 接回 */
    const leave = () => {
      if (st.settled) return;
      st.settled = true;
      job.bg = true;
      devSuggestJobDetach(job, hooks);
      host.removeEventListener("keydown", onKey);
      /* 只隐藏，不关作业；devDlgClose 顺带清掉本框的样式类，避免污染下一个弹窗 */
      if (seq === _mtDialogSeq) devDlgClose(host, box, "mt-sug-box");
      resolve(null);
      if (typeof toast === "function")
        toast(I18n.t("AI 继续后台调研，完成后自动弹出。"));
    };
    const goDevelop = (ids, supplement) => {
      if (!job.suggestion) return;
      if (!ids.length && !supplement) {
        job.err = I18n.t("至少勾选一个方案，或在「补充说明」里写下你要做什么。");
        render();
        return;
      }
      const brief = devSuggestBriefText(node, job.suggestion, ids, supplement);
      node.devSuggest = Object.assign({}, node.devSuggest || {}, {
        picked: ids,
        supplement,
      });
      scheduleSave(true);
      /* 补充说明已随本轮开工：清掉草稿，下次打开方案清单不带重复内容 */
      devDraftSet(node, "supplement", "");
      /* 本轮勾选 + 补充也记入「建议」会话：用户的决策随会话留存，不只在弹窗里 */
      devSuggestRecordPicked(node, ids, supplement);
      finish({ action: "dev", text: brief, picked: ids, supplement });
      startDevSessionWithText(node, brief);
    };
    function onKey(ev) {
      /* 视图已被更新的弹窗取代 → 摘掉自己的监听并装死（绝不误停别人的作业） */
      if (!alive()) {
        host.removeEventListener("keydown", onKey);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        /* 调研中按 Esc = 「返回」（后台继续跑，完成后跳窗）；方案 / 失败态 = 关闭对话框。
           破坏性的「停止生成」不再绑在 Esc 上，只能点按钮显式触发 */
        if (job.phase === "run") leave();
        else finish(null);
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        if (job.phase === "options") {
          const extra = ta ? String(ta.value || "").trim() : "";
          goDevelop(
            job.suggestion.items.filter((it) => job.picked[it.id]).map((it) => it.id),
            extra,
          );
        } else if (job.phase === "failed") runOnce();
      } else if (
        job.phase === "options" &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        /^[1-9]$/.test(ev.key)
      ) {
        const ae = document.activeElement;
        if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return;
        const it = job.suggestion.items[Number(ev.key) - 1];
        if (!it) return;
        ev.preventDefault();
        job.picked[it.id] = !job.picked[it.id];
        render();
      }
    }
    function render() {
      if (!alive()) return;
      if (titleEl)
        titleEl.textContent =
          (job.phase === "run"
            ? I18n.t("生成建议")
            : job.phase === "failed"
              ? I18n.t("建议生成失败")
              : I18n.t("建议")) +
          " · " +
          (node.title || I18n.t("开发节点"));
      if (bodyEl) bodyEl.innerHTML = "";
      const footEl = host.querySelector("#mtDlgFoot");
      if (footEl) footEl.innerHTML = "";
      ta = null;
      logEl = null;
      if (job.phase !== "options") {
        const rows = devDlgEl("div", "mt-form-rows");
        const addRow = (k, v) => {
          const r = devDlgEl("div", "mt-form-row");
          r.appendChild(devDlgEl("span", "mt-form-k", k));
          r.appendChild(devDlgEl("span", "mt-form-v", v));
          rows.appendChild(r);
        };
        addRow(
          I18n.t("项目根目录"),
          devPathOf(node) || I18n.t("（未设置 · 用默认工作区）"),
        );
        if (job.focus) addRow(I18n.t("本轮关注点"), clipStr(job.focus, 90));
        if (job.phase === "run") {
          const r = devDlgEl("div", "mt-form-row");
          r.appendChild(devDlgEl("span", "mt-form-k", I18n.t("进度")));
          const v = devDlgEl("span", "mt-form-v");
          const s = devDlgEl("span", null, "");
          s.id = "mtSugElapsed";
          v.appendChild(s);
          r.appendChild(v);
          rows.appendChild(r);
        }
        bodyEl.appendChild(rows);
        if (job.phase === "run") {
          bodyEl.appendChild(
            devDlgEl(
              "p",
              "mt-dialog-msg",
              I18n.t(
                "AI 正在阅读项目代码，评估这个功能块下一步该实现什么。整个过程只读，期间你可以照常操作其它节点。",
              ),
            ),
          );
          logEl = devDlgEl("div", "mt-sug-log");
          for (const l of job.lines) logEl.appendChild(devDlgEl("div", "mt-sug-log-row", l));
          bodyEl.appendChild(logEl);
          /* 已「返回」后台：在日志底部留一条常驻提示（用户接回来时能立刻明白状态） */
          if (job.bg)
            bodyEl.appendChild(
              devDlgEl(
                "p",
                "mt-sug-log-note",
                I18n.t("调研中·已转入后台，可点该块的「建议」查看进度。"),
              ),
            );
        } else {
          bodyEl.appendChild(devDlgEl("p", "mt-form-warn", job.err));
        }
        if (footEl) {
          if (job.running) {
            /* 调研中：可「返回」让它在后台继续跑，也可显式「停止生成」 */
            footEl.appendChild(
              devDlgBtn({
                label: I18n.t("返回"),
                title: I18n.t("关掉本框，调研继续在后台运行，完成后自动弹出"),
                run: leave,
              }),
            );
            footEl.appendChild(
              devDlgBtn({
                label: I18n.t("停止生成"),
                danger: true,
                title: I18n.t("显式取消这一轮调研（不再有结果；Esc 不会触发本操作）"),
                run: () => {
                  abortRun();
                  finish(null);
                },
              }),
            );
          } else {
            footEl.appendChild(
              devDlgBtn({ label: I18n.t("关闭"), run: () => finish(null) }),
            );
          }
          if (job.phase === "failed")
            footEl.appendChild(
              devDlgBtn({
                label: I18n.t("再试一次"),
                primary: true,
                title: I18n.t("Ctrl+Enter"),
                run: runOnce,
              }),
            );
        }
      } else {
        const r = devSuggestPickBody(host, {
          suggestion: job.suggestion,
          picked: job.picked,
          err: job.err,
          supplement: st.supplement,
          onCancel: () => finish(null),
          onRegen: runOnce,
          onDev: goDevelop,
          onSupplement: (t) => {
            st.supplement = t;
            devDraftSet(node, "supplement", t);
          },
          onPick: () => {
            job.err = "";
          },
        });
        job.viewed = true;
        /* 就绪态已被用户消费：该块「建议」按钮回到标准流程（先确认框，可看上次结果） */
        job.ready = false;
        ta = r.ta;
        try {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        } catch (_) {}
      }
      host.classList.add("on");
      host.removeEventListener("keydown", onKey);
      host.addEventListener("keydown", onKey);
      stampElapsed();
    }
    render();
    /* 幂等发起：只有这一轮从没跑过才向引擎发调研。
       接管在途作业 = 只看进度，绝不重复发起（同一个 runKey 会互相覆盖取消句柄） */
    if (!job.started) runOnce();
    else
      devSuggestJobLog(job, I18n.t("已接回本轮调研：它仍在进行，未重复发起。"));
  });
}

/* ---------- 上次建议（不重跑模型） ---------- */
function devSuggestCachedDialog(node, sug, focus) {
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const box = devDlgOpen(host, "mt-sug-box");
    const titleEl = host.querySelector("#mtDlgTitle");
    /* st.supplement：本框未提交的补充说明（数字键重绘 / 报错重绘都不吞内容） */
    const st = {
      picked: {},
      err: "",
      settled: false,
      supplement: String(
        (sug && sug.supplement) || focus || devDraftOf(node, "supplement") || "",
      ),
    };
    let taRef = null;
    const prev = (sug && sug.picked) || [];
    sug.items.forEach((it, i) => {
      st.picked[it.id] = prev.length ? prev.indexOf(it.id) >= 0 : i === 0;
    });
    const alive = () => !st.settled && seq === _mtDialogSeq;
    const finish = (v) => {
      if (st.settled) return;
      st.settled = true;
      host.removeEventListener("keydown", onKey);
      devDlgClose(host, box, "mt-sug-box");
      resolve(v || null);
    };
    const go = (ids, extra) => {
      if (!ids.length && !extra) {
        st.err = I18n.t("至少勾选一个方案，或在「补充说明」里写下你要做什么。");
        render();
        return;
      }
      const brief = devSuggestBriefText(node, sug, ids, extra);
      node.devSuggest = Object.assign({}, node.devSuggest || {}, {
        picked: ids,
        supplement: extra,
      });
      scheduleSave(true);
      /* 补充说明已随本轮开工：清掉草稿，下次打开方案清单不带重复内容 */
      devDraftSet(node, "supplement", "");
      /* 本轮勾选 + 补充也记入「建议」会话：用户的决策随会话留存，不只在弹窗里 */
      devSuggestRecordPicked(node, ids, extra);
      finish({ action: "dev", text: brief, picked: ids, supplement: extra });
      startDevSessionWithText(node, brief);
    };
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        finish(null);
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        go(
          sug.items.filter((it) => st.picked[it.id]).map((it) => it.id),
          taRef ? String(taRef.value || "").trim() : "",
        );
      } else if (
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        /^[1-9]$/.test(ev.key)
      ) {
        const ae = document.activeElement;
        if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return;
        const it = sug.items[Number(ev.key) - 1];
        if (!it) return;
        ev.preventDefault();
        st.picked[it.id] = !st.picked[it.id];
        render();
      }
    }
    function render() {
      if (!alive()) return;
      if (titleEl)
        titleEl.textContent =
          I18n.t("建议（上次结果）") +
          " · " +
          devSuggestStamp(sug.at) +
          " · " +
          (node.title || I18n.t("开发节点"));
      const built = devSuggestPickBody(host, {
        suggestion: sug,
        picked: st.picked,
        err: st.err,
        supplement: st.supplement,
        hint: I18n.t(
          "这是上一次生成的方案（未重新调用模型）。想听新的评估：点「换一批」重新让 AI 判断，或取消后在确认框里选「确认生成建议」。数字键勾选 · Ctrl+Enter 开发 · Esc 取消",
        ),
        onCancel: () => finish(null),
        onRegen: () => finish({ action: "regen" }),
        onDev: go,
        onSupplement: (t) => {
          st.supplement = t;
          devDraftSet(node, "supplement", t);
        },
        onPick: () => {
          st.err = "";
        },
      });
      taRef = built.ta;
      host.classList.add("on");
      host.removeEventListener("keydown", onKey);
      host.addEventListener("keydown", onKey);
    }
    render();
  });
}

/* ---------- 「建议」按钮入口：确认框 → AI 评估 → 勾选 → 开发 ---------- */
async function suggestDevNode(node) {
  if (!node || node.kind !== "super" || !node.dev) return;
  const dk = devKindOf(node) || "module";
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  const cached = devSuggestOf(node);
  /* 入口幂等：该块的调研作业（可能正在后台跑，也可能跑完还没被看过） */
  const job = devSuggestJobOf(node);
  const busy = devSuggestJobBusy(node);
  if (job && !busy && (job.ready || (job.phase === "options" && !job.viewed)))
    return devSuggestDialog(node, {});
  const rows = [
    [I18n.t("元素类型"), I18n.t(DEV_KIND_LABEL[dk] || "模块")],
    [I18n.t("开发状态"), devStatusText(devStatusOf(node))],
    [I18n.t("Agent 模型"), devModelDialogText(node)],
    [I18n.t("Agent 预设"), devPresetDialogText(node)],
    [I18n.t("思考强度"), devEffortDialogText(node)],
    [I18n.t("项目根目录"), p || I18n.t("（未设置）")],
    [
      I18n.t("下层元素"),
      kids.length ? kids.length + I18n.t(" 个") : I18n.t("（无）"),
    ],
    [I18n.t("历史会话"), devSessionsOf(node).length + I18n.t(" 个")],
  ];
  if (busy)
    rows.push([
      I18n.t("调研进度"),
      I18n.t("AI 只读调研进行中 · ") +
        busy.elapsed +
        " · " +
        busy.toolCount +
        I18n.t(" 次工具调用"),
    ]);
  if (cached)
    rows.push([
      I18n.t("上次建议"),
      cached.items.length +
        I18n.t(" 条 · ") +
        devSuggestStamp(cached.at) +
        (cached.picked.length
          ? " · " + I18n.t("已采纳 ") + cached.picked.length + I18n.t(" 条")
          : ""),
    ]);
  const actions = [{ id: "cancel", label: I18n.t("取消") }];
  if (cached) actions.push({ id: "cached", label: I18n.t("查看上次建议") });
  if (busy)
    /* 已有在途调研：只给「接回去看」，不给第二个「确认生成建议」 */
    actions.push({ id: "attach", label: I18n.t("查看调研进度"), primary: true });
  else
    actions.push({ id: "go", label: I18n.t("确认生成建议"), primary: true });
  const res = await mtDialogForm({
    title: I18n.t("建议") + " · " + (node.title || I18n.t("开发节点")),
    wide: true,
    rows,
    note: devNoteDialogField(node),
    msg: busy
      ? I18n.t(
          "这个功能块已经有一轮只读调研在跑（同一块不会重复发起，以免两轮结果互相覆盖）。你可以直接离开去画布上继续操作，或点「查看调研进度」接回去看它读到哪一步；「本轮关注点」要改动得等这轮结束后再生成一轮。",
        )
      : I18n.t(
          "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），再给出 4 条「下一步实现什么」的方案。你可以在同一个对话框里多选、补充，然后点该对话框里的「开发」直接开工。",
        ),
    warn: p
      ? ""
      : I18n.t(
          "尚未设置项目根目录（devPath）：AI 只能在默认工作区里找代码，建议先在顶层功能块上设置项目路径。",
        ),
    textarea: devDraftTextareaOpts(node, "suggest", {
      label: I18n.t("本轮关注点（可选 · 留空由 AI 自行判断）"),
      placeholder: I18n.t(
        "例如：这轮只看健壮性和测试；优先把与「网络层」的接线补上；不要引入新依赖…",
      ),
      rows: 4,
    }),
    /* 边写边留存：取消 / 被别的事务顶出对话框都不丢，下次打开原样回填 */
    onText: (t) => devDraftSet(node, "suggest", t),
    hint: I18n.t(
      "确认 = 只读评估（工作区 = 项目根目录）· 生成后可多选 / 换一批 · 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 确认 · Esc 取消",
    ),
    actions,
  });
  if (!res) return;
  const focus = String(res.text || "").trim();
  if (res.action === "cached") {
    devDraftSet(node, "suggest", "");
    const out = await devSuggestCachedDialog(node, cached, focus);
    if (out && out.action === "regen") await devSuggestDialog(node, { focus });
    return;
  }
  /* go / attach 都交给 devSuggestDialog：它在途时只会接管视图，不会再发一轮 */
  if (res.action === "go" || res.action === "attach") {
    devDraftSet(node, "suggest", "");
    await devSuggestDialog(node, { focus });
  }
}

/* ============ 开发节点「问询」：该功能块的只读会话 ============
 * 需求：开发节点 body 的「问询」按钮 —— 让用户直接问「这个模块现在怎么样 /
 * 为什么这么设计 / 下一步做什么」，AI 依据项目真实代码只读回答。
 * 承载方式与「开发 / 细化」一致：一次问询 = 该功能块的一条会话（app.js 的
 * startDevAskSession），问题就是会话里的用户消息，回答永久落在该会话中，
 * 可随时回看、可继续追问；同一功能块复用同一条问询会话。
 * 与旧做法的差别（也就是「问询无法查看」这个 Bug 的根因）：问询原本跑在
 * #mtDialog 这个全仓共用单宿主的弹窗 + devAskJobs 内存注册表上，视图一旦被别的
 * 弹窗顶掉、或用户点了「返回后台」，结算时既没有自动重开也没有提示，回答就再无
 * 入口；换成会话承载后，结果不在弹窗里，而在会话里，跟弹窗活不活着无关。
 * 只读怎么保证：
 *   1) 下面这份「只读问询任务书」作为会话契约 _devContract，每轮（含用户追问）
 *      随系统提示注入：明确禁止写文件 / 有副作用的命令 / 改画布 / todo / goal /
 *      subagent 实现工作，只放开 read / glob / grep / 只读命令 / canvas_get /
 *      mtnode_db 查询 / web_search / 加载技能；
 *   2) 问询会话不回写节点：不改 note、不改 devStatus、不补 devFiles，也故意不进
 *      devSessionIds（不污染「最近一次要求」与「会话 N」跳转），id 记在
 *      node.devAskSessionId；用户要动手 → 点该功能块的「开发」按钮正式开工。
 * 与「建议」的区别：不产出 4 条方案契约，直接给出针对问题的自由文本回答。
 */
/* 只读纪律（问询任务书的规则段）：可以放开了读，但不许动一根手指 */
function devAskSystemPrompt() {
  return [
    "本会话是 MTNode「开发节点」的**问询会话**：只读地回答用户关于本功能块（模块）的问题——职责、代码结构、真实完成度、接口与数据流、下一步建议等。",
    "整个过程**严格只读**：禁止创建 / 修改 / 删除任何文件（write、edit、str_replace_editor、文件保存类动作）；禁止执行任何有副作用的命令（安装 / 删除 / 移动 / 复制 / 构建 / git commit 与 checkout / 重启服务 / 清理目录）；禁止调用 mtnode_canvas_edit / mtnode_app 的修改类动作；禁止用 todo_write 登记执行清单；禁止用 create_goal 立执行目标；禁止用 subagent 派生实现工作。",
    "允许并鼓励只读调研：read、glob、grep、只读命令（git status / git log / git diff --stat / node --check / ls）、mtnode_canvas_get、mtnode_db 查询、web_search、加载技能。",
    "纪律：回答必须来自你真实读到的代码与画布信息，引用具体文件路径（能带行号更好）；查不到就直说「代码里没找到」，禁止臆测或用通用最佳实践凑数。",
    "共识：若项目根目录存在 AGENTS.md（Agent 共识文件），先读它并遵守其中的「目录约定」与「不要修改」清单；回答中涉及路径时按约定表述，绝不建议触碰清单内路径。",
    "若用户的问题本质上是「请帮我改 / 实现 / 重构」，先礼貌说明问询是只读的、不会改动任何文件，再给出实现思路或修改方案概要，并建议用户点击该功能块的「开发」按钮正式开工。",
    "回答简洁、直接、分点（交流语言按文末「语言口味」跟随界面设置），最后不要输出任何 JSON 契约或多余格式。",
  ].join("\n");
}
/* 问询上下文：比建议精简（不带「上一次 AI 建议」的纠偏说明），其余同源 */
function devAskContextText(node) {
  const dk = devKindOf(node) || "module";
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  const chain = devAncestorChain(node);
  const lines = [];
  lines.push(
    I18n.t("目标功能块：") +
      (node.title || I18n.t("未命名模块")) +
      "（" +
      I18n.t(DEV_KIND_LABEL[dk] || "模块") +
      " · " +
      devStatusText(devStatusOf(node)) +
      "）",
  );
  const noteParts = devNoteParts(node && node.note);
  lines.push(
    I18n.t("模块功能（面向非技术）：") +
      (noteParts.design || I18n.t("（暂无 · 该块在业务上做什么、给谁用还没写清楚）")),
  );
  lines.push(
    I18n.t("实现要点（面向技术）：") +
      (noteParts.impl || I18n.t("（暂无 · 实现方案梗概待补）")),
  );
  lines.push(
    I18n.t("项目根目录：") + (p || I18n.t("（未设置 · 请以会话工作区为项目根）")),
  );
  if (chain.length) {
    lines.push(I18n.t("所属上层链路："));
    chain.forEach((a, i) => {
      lines.push(
        "  ".repeat(i + 1) + (a.title || a.id) + "（" + devStatusText(devStatusOf(a)) + "）",
      );
    });
  }
  const depthTxt = devDepthLineOf(node);
  if (depthTxt)
    lines.push(I18n.t("细化深度现状（细化＝深度，非本层展开数量）：") + depthTxt);
  lines.push(I18n.t("本块已有下层元素（共 ") + kids.length + I18n.t(" 个）："));
  if (!kids.length) lines.push("  " + I18n.t("（无 · 尚未细化到文件 / 类）"));
  for (const k of kids.slice(0, 30)) lines.push(devNodeBriefLine(k));
  if (kids.length > 30)
    lines.push("  … " + I18n.t("其余 ") + (kids.length - 30) + I18n.t(" 个"));
  lines.push(I18n.t("画布上的开发进度总览（* 为本块）："));
  lines.push(devProgressOverviewText(node) || "  " + I18n.t("（无）"));
  lines.push(I18n.t("本块的历史开发会话："));
  lines.push(devSessionDigestText(node));
  return lines.join("\n");
}
/* 任务书收尾指令：问题本身不进任务书（会话里就是用户消息），免得多轮追问被首问绑死 */
function devAskPrompt() {
  return [
    I18n.t("工作方式：用户每提出一个问题，先只读调研项目里的真实代码与该模块的开发进度，再直接给出回答。"),
    I18n.t("本会话不做任何修改：不改文件、不改画布、不回写节点概述与开发状态；要动手请让用户点该功能块的「开发」按钮。"),
    I18n.t("会话里的每一个问题都要回答；与本模块无关的请求，礼貌说明本会话只负责该模块的问询。"),
  ].join("\n");
}
/* 只读问询任务书 = 该问询会话的契约：写进 session._devContract，每轮随系统提示注入 */
function devAskContractText(node) {
  const dk = devKindOf(node) || "module";
  const lines = [];
  lines.push(
    I18n.t("【只读问询任务书】") +
      " " +
      (node.title || I18n.t("未命名模块")) +
      "（" +
      I18n.t(DEV_KIND_LABEL[dk] || "模块") +
      " · " +
      I18n.t("问询会话") +
      "）",
  );
  lines.push("");
  lines.push(devAskSystemPrompt());
  lines.push("");
  lines.push(devAskContextText(node));
  lines.push("");
  lines.push(devAskPrompt());
  return lines.join("\n");
}
/* ---------- 「问询」按钮入口：确认框 → 该功能块的只读会话 ---------- */
async function askDevNode(node) {
  if (!node || node.kind !== "super" || !node.dev) return;
  if (typeof startDevAskSession !== "function") return;
  const dk = devKindOf(node) || "module";
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  const sess = typeof devAskSessionOf === "function" ? devAskSessionOf(node) : null;
  const rows = [
    [I18n.t("元素类型"), I18n.t(DEV_KIND_LABEL[dk] || "模块")],
    [I18n.t("开发状态"), devStatusText(devStatusOf(node))],
    [I18n.t("Agent 模型"), devModelDialogText(node)],
    [I18n.t("Agent 预设"), devPresetDialogText(node)],
    [I18n.t("思考强度"), devEffortDialogText(node)],
    [I18n.t("项目根目录"), p || I18n.t("（未设置）")],
    [
      I18n.t("下层元素"),
      kids.length ? kids.length + I18n.t(" 个") : I18n.t("（无）"),
    ],
    [I18n.t("历史会话"), devSessionsOf(node).length + I18n.t(" 个")],
  ];
  if (sess)
    rows.push([I18n.t("问询会话"), I18n.t("沿用该功能块已有的只读会话 · 追问接在同一上下文里")]);
  const res = await mtDialogForm({
    title: I18n.t("问询") + " · " + (node.title || I18n.t("开发节点")),
    wide: true,
    rows,
    note: devNoteDialogField(node),
    msg: I18n.t(
      "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），然后直接回答你的问题。回答留在该模块的只读会话里，随时可回看、可接着追问。",
    ),
    warn: p
      ? ""
      : I18n.t(
          "尚未设置项目根目录（devPath）：AI 只能在默认工作区里找代码，建议先在顶层功能块上设置项目路径。",
        ),
    textarea: devDraftTextareaOpts(node, "ask", {
      label: I18n.t("你要问的问题"),
      placeholder: I18n.t(
        "例如：这个模块现在的真实完成度如何？入口在哪？关键文件是哪些？下一步该做什么？为什么这么设计？…",
      ),
      rows: 5,
      requiredMsg: I18n.t("请填写要问的问题"),
    }),
    /* 边写边留存：取消 / 被别的事务顶出对话框都不丢，下次打开原样回填 */
    onText: (t) => devDraftSet(node, "ask", t),
    hint: I18n.t(
      "确认 = 新建 / 接入该模块的只读问询会话（工作区 = 项目根目录 · 不改文件、不改画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消",
    ),
    requireText: true,
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "go", label: I18n.t("开始问询"), primary: true },
    ],
  });
  if (!res || res.action !== "go") return;
  const question = String(res.text || "").trim();
  if (!question) return;
  /* 问题已交给问询会话：清掉草稿，下次打开是空白 */
  devDraftSet(node, "ask", "");
  await startDevAskSession(node, question);
}

/* ---------- 文件节点「打开」：打开对应的源码文件 ---------- */
/* 路径约定：文件节点标题 = 相对项目根目录（devPath）的路径（如 renderer/app.js），
   或直接写绝对路径；标题不像路径时退而打开项目根目录 */
async function openDevFileNode(node) {
  if (!node || node.kind !== "super" || !node.dev || devKindOf(node) !== "file") return;
  const title = String(node.title || "").trim();
  const root = devPathOf(node);
  let target = "";
  if (isAbsPath(title)) {
    target = title;
  } else if (root && title) {
    target = joinPath(root, title);
  } else if (root) {
    target = root;
  }
  if (!target) {
    toast(
      I18n.t(
        "无法定位文件：请先在顶层功能块设置项目根目录（devPath），并把文件节点标题改为相对路径（如 renderer/app.js）",
      ),
      "warn",
    );
    return;
  }
  let ex = false;
  try {
    ex = !!(await window.api.fileExists(target));
  } catch (_) {}
  /* agent.md 入口：项目根没有 agent.md 时回退到既有 AGENTS.md 共识文件 */
  if (/^agent\.md$/i.test(fileName(target) || target) && !ex) {
    const alt = joinPath(root, "AGENTS.md");
    try {
      ex = !!(await window.api.fileExists(alt));
      if (ex) target = alt;
    } catch (_) {}
  }
  if (!ex) {
    toast(I18n.t("文件不存在：") + target, "warn");
    return;
  }
  /* Markdown / YAML：应用内阅读器（可查看 / 编辑 / 保存）；其余交给系统默认方式打开 */
  if (isMdFilePath(target)) {
    openMdViewer(target);
    toast(I18n.t("已打开：") + target, "ok");
    return;
  }
  if (isYamlFilePath(target)) {
    openYamlViewer(target);
    toast(I18n.t("已打开：") + target, "ok");
    return;
  }
  let r = null;
  try {
    r = await window.api.shellOpenPath(target);
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) };
  }
  if (r && r.ok) toast(I18n.t("已打开：") + target, "ok");
  else toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "warn");
}

/* ============ 开发节点「核心文件列表」（node.devFiles） ============
 * 需求：给开发节点增加一个「核心文件列表」，最多只列举 10 个；最外层开发节点
 *      （项目节点）不列举。展示与交互在 app-canvas.js：节点 body 下方一个
 *      「文件 N」按钮，点开成列表，点任意一行 = 在资源管理器中定位该文件。
 * 三条来源合流（优先级从高到低）：
 *   1) 开发 / 细化 / 建议会话用 mtnode_canvas_edit 的 devFiles 补丁回写；
 *   2) 用户在展开面板里手工编辑（每行一个路径）；
 *   3) 前两者都为空时的自动兜底收集：本块（或后代 devKind=file 块）的标题
 *      + 本块概述【实现】里出现的路径 token，按 devPathOf(node) 解析。
 * 单一口径（避免各处各写各的）：
 *   · 路径归一与 DEV_CORE_FILES_MAX 上限只在 devCoreFilesNormalize() 里强制一次，
 *     UI 编辑 / Agent 补丁 / 兜底收集三个写入口全部经过它；
 *   · 分隔符统一存 '/'；绝对路径若落在本块项目根内会折成相对路径（与保存节点
 *     preferRelativeSavePath 同一取向），根外的绝对路径原样保留；
 *   · 最外层（项目）块一律：读为空、写被拒（devCoreFilesSet 返回 null）。
 */
const DEV_CORE_FILES_MAX = 10;
/* 单条路径长度上限：防脏数据（整段说明文字被当成一条路径）把节点撑大 */
const DEV_CORE_FILE_MAX_LEN = 240;
/* 自动兜底时认作「源码文件」的扩展名白名单：宁可少收，不把 "v1.1.28" / "e.g" 当路径 */
const DEV_CORE_FILE_EXTS = [
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "json", "json5", "yaml",
  "yml", "toml", "md", "mdx", "html", "htm", "css", "scss", "less", "svg", "txt",
  "csv", "sql", "db", "sqlite", "py", "rs", "go", "java", "kt", "c", "h", "cpp",
  "hpp", "cc", "sh", "ps1", "bat", "cmd", "nsh", "nsi", "ini", "cfg", "env",
  "lock", "njk", "tpl", "glsl", "wgsl", "proto", "graphql",
];

/* 开发块判定优先用 app.js 的共用真源；单独加载本文件的沙箱（冒烟测试）退回同口径 */
function devCoreIsBlock(node) {
  return typeof devIsDevBlock === "function"
    ? devIsDevBlock(node)
    : !!(node && node.kind === "super" && node.dev && !node.db);
}
/* 顶层（项目）开发块：优先 app.js 的 devIsTopBlock；沙箱里用 devAncestorChain 走同一条链 */
function devCoreIsTopBlock(node) {
  if (!devCoreIsBlock(node)) return false;
  if (typeof devIsTopBlock === "function") return devIsTopBlock(node);
  return !devAncestorChain(node).some(devCoreIsBlock);
}
/* 绝对路径判定（isAbsPath 真源在 app.js，依赖 window.api；缺省时退回等价正则） */
function devCoreIsAbsPath(p) {
  const s = String(p || "");
  if (!s) return false;
  return typeof isAbsPath === "function"
    ? !!isAbsPath(s)
    : /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.startsWith("/") && !s.startsWith("//"));
}
/* 本块的项目根（统一正斜杠、无尾斜杠）；未设置 → "" */
function devCoreFileRoot(node) {
  const raw =
    typeof devPathOf === "function" ? String(devPathOf(node) || "") : "";
  return raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}
/* 单条路径清洗：剥引号 / 括号包裹、反斜杠转 '/'、去掉首尾多余标点与 './'。
   只做「像不像一条路径」的最低判断（通配符、越权的 ../、超长一律拒绝），
   扩展名白名单只用于自动兜底（那里是从自由文本里抠 token，需要更严）。 */
function devCoreFileNormEntry(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^[`'"“”‘’(\[【]+/, "").replace(/[`'"“”‘’)\]】.,;:，。；：]+$/, "");
  s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  /* 越出项目根的相对写法（../x.js）一律拒绝：展示与 reveal 都按 devPathOf 解析，
     让它进来等于给了条逃出项目根的路 */
  if (/(^|\/)\.\.(\/|$)/.test(s)) return "";
  s = s.replace(/\/\.\//g, "/");
  while (/^\.\//.test(s)) s = s.replace(/^\.\//, "");
  /* 以 / 结尾 = 目录（本列表只收文件） */
  if (/\/$/.test(s)) return "";
  s = s.trim();
  if (!devCoreIsAbsPath(s)) s = s.replace(/^\/+/, "");
  if (!s || s.length > DEV_CORE_FILE_MAX_LEN) return "";
  if (/[*?<>|"“”‘’]/.test(s) || /[\r\n\t]/.test(s)) return "";
  return s;
}
/* 扩展名白名单（自动兜底用）：token 必须以某个已知扩展名结尾 */
function devCoreFileLooksLikeFile(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ""));
  return !!(m && DEV_CORE_FILE_EXTS.indexOf(m[1].toLowerCase()) >= 0);
}
/* 落在本块项目根内的绝对路径折成相对路径（根外原样），便于展示与去重 */
function devCoreFileRelativize(rootFwd, entry) {
  if (!rootFwd || !devCoreIsAbsPath(entry)) return entry;
  const a = entry.replace(/\\/g, "/");
  const win = /^[a-zA-Z]:/.test(rootFwd);
  const same = win ? a.toLowerCase().startsWith(rootFwd.toLowerCase() + "/") : a.startsWith(rootFwd + "/");
  return same ? a.slice(rootFwd.length + 1) : entry;
}
/**
 * 核心文件列表的**唯一**归一入口：去空 → 逐条清洗 → 绝对折相对 → 去重 → 裁剪到上限。
 * @param {string[]|string} list 数组，或按行 / 逗号分隔的字符串
 * @param {object} node 目标开发节点（用于取项目根做相对化与去重键）
 * @param {object} [stats] 可选回报对象：stats.dropped = 因超出上限被丢弃的条数
 * @returns {string[]} 最多 DEV_CORE_FILES_MAX 条，全部以 '/' 分隔
 */
function devCoreFilesNormalize(list, node, stats) {
  const src = Array.isArray(list)
    ? list
    : typeof list === "string"
      ? list.split(/[\r\n]+|[,，;；]\s*/)
      : [];
  const root = devCoreFileRoot(node);
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of src) {
    let s = devCoreFileNormEntry(raw);
    if (!s) continue;
    s = devCoreFileRelativize(root, s);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= DEV_CORE_FILES_MAX) {
      dropped++;
      continue;
    }
    out.push(s);
  }
  if (stats && typeof stats === "object") stats.dropped = dropped;
  return out;
}
/* 本块已显式写入（Agent 回写 / 用户编辑）的核心文件；顶层块与非开发块恒为空 */
function devCoreFilesStoredOf(node) {
  if (!devCoreIsBlock(node) || devCoreIsTopBlock(node)) return [];
  return devCoreFilesNormalize(node && node.devFiles, node);
}
/* 后代 devKind=file 块的标题（按约定就是相对项目根的路径），就近优先、深度优先 */
function devCoreFileTitlesOf(node) {
  const out = [];
  const seen = new Set();
  seen.add(node.id);
  const walk = (host) => {
    for (const k of devChildrenOf(host)) {
      if (!k || seen.has(k.id) || out.length >= DEV_CORE_FILES_MAX) continue;
      seen.add(k.id);
      const isDev = k.kind === "super" && k.dev;
      if (isDev && devKindOf(k) === "file" && String(k.title || "").trim())
        out.push(String(k.title).trim());
      if (isDev) walk(k);
    }
  };
  walk(node);
  return out;
}
/* 从自由文本（概述【实现】段）里抠路径 token：允许相对路径与盘符绝对路径 */
function devCoreFileTokensOf(text) {
  const s = String(text || "");
  const re =
    /[A-Za-z0-9_.@\-]+(?:\/[A-Za-z0-9_.@\-]+)*\.[A-Za-z][A-Za-z0-9]{1,9}/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    if (m[0].indexOf(":") >= 0 && !/^[a-zA-Z]:\//.test(m[0])) continue;
    const t = devCoreFileNormEntry(m[0]);
    if (!t || !devCoreFileLooksLikeFile(t)) continue;
    out.push(t);
    if (out.length >= DEV_CORE_FILES_MAX * 2) break;
  }
  return out;
}
/* 自动兜底收集：本块自身是文件级块（标题即路径）→ 本块概述【实现】的路径 token
   → 后代 devKind=file 块的标题；全部经 devCoreFilesNormalize 归一与裁剪 */
function devCoreFilesAutoOf(node) {
  if (!devCoreIsBlock(node) || devCoreIsTopBlock(node)) return [];
  const cands = [];
  if (devKindOf(node) === "file" && String(node.title || "").trim())
    cands.push(String(node.title).trim());
  const parts = devNoteParts(node && node.note);
  for (const t of devCoreFileTokensOf(parts.impl || parts.design)) cands.push(t);
  for (const t of devCoreFileTitlesOf(node)) cands.push(t);
  return devCoreFilesNormalize(cands, node);
}
/* 展示口径的最终列表：显式写入优先，为空时自动兜底；最外层（项目）块不列举 */
function devCoreFilesOf(node) {
  const stored = devCoreFilesStoredOf(node);
  if (stored.length) return stored;
  return devCoreFilesAutoOf(node);
}
/* 当前列表来源（UI 据此提示「自动收集 · 点编辑确认」）：manual / auto / "" */
function devCoreFilesSourceOf(node) {
  if (!devCoreIsBlock(node) || devCoreIsTopBlock(node)) return "";
  if (devCoreFilesStoredOf(node).length) return "manual";
  return devCoreFilesAutoOf(node).length ? "auto" : "";
}
/**
 * 写入本块核心文件（UI 编辑入口用）：归一化 → 记历史 → 立刻落盘。
 * @returns {string[]|null} 实际写入的列表；非开发块 / 最外层（项目）块返回 null（拒绝）
 */
function devCoreFilesSet(node, list, stats) {
  if (!devCoreIsBlock(node) || devCoreIsTopBlock(node)) return null;
  const next = devCoreFilesNormalize(list, node, stats);
  const prev = Array.isArray(node.devFiles) ? node.devFiles : [];
  if (JSON.stringify(next) === JSON.stringify(prev)) return next;
  pushHistory();
  node.devFiles = next;
  scheduleSave(true);
  return next;
}
/* 一条核心文件在本块项目根下的绝对路径（相对路径按 devPathOf 解析）；解不出 → "" */
function devCoreFileAbs(node, entry) {
  const s = devCoreFileNormEntry(entry);
  if (!s) return "";
  if (devCoreIsAbsPath(s)) return s;
  const root = devCoreFileRoot(node);
  if (!root) return "";
  return typeof joinPath === "function" ? joinPath(root, s) : root + "/" + s;
}
/* 展示用主标签 = 文件名（最后一段）；整条相对路径本身可直接作副标签 */
function devCoreFileLabel(entry) {
  const s = devCoreFileNormEntry(entry);
  if (!s) return "";
  const base = typeof fileName === "function" ? fileName(s) : s.split("/").pop();
  return String(base || s).trim();
}

/* ============ 开发节点颜色：菜单栏小按钮 + HSV 色板 ============
 * 需求：开发节点允许更改节点颜色——菜单栏增加一个小按钮（显示当前颜色），
 * 点击后展开 HSV 色板，用户可手动修改（方块=饱和度×明度拖动 / 色相条 /
 * 直接输入 Hex）。
 * 数据存 node.devColor（#rrggbb 小写；空串 = 按元素类型默认色），随工作流保存。
 * 渲染：nodeElement 依据 devColorOf() 给节点元素加 .dev-custom-color 并注入
 * --dev-color（外框）/ --dev-glow（运行呼吸灯），覆盖元素类型的默认配色。
 * 本节含两张色卡：DEV_KIND_COLOR（元素类型默认色）与 DEV_FUNC_COLORS
 * （功能色卡：按功能分类给功能块上色，见下方「功能色卡」小节）。
 */

/* 元素类型默认外框色（与 canvas.css 的 .dev-el-* 配色保持一致） */
const DEV_KIND_COLOR = {
  module: "#6fe3a5",
  file: "#6db4ff",
  class: "#ffb454",
  interface: "#c792ea",
  enum: "#ff8fa3",
};

/* ============ 功能色卡：按「功能分类」给功能块不同颜色的边框 ============
 * 需求：创建开发节点时，根据功能和类型使用不同的颜色边框（提前设计一套
 * 色卡对应不同功能）。
 * 维度：功能色只作用于 devKind = module 的功能块；file / class / interface /
 * enum 等下层元素继续用 DEV_KIND_COLOR 的元素类型默认色，层级一眼可辨。
 * 优先级：用户手选（devColorOf 非空）> 功能色（本表按关键词推断）> 元素类型默认色。
 * 唯一真源：色板 UI、自动上色、Agent 透出、设计文档 / 用户手册、冒烟测试一律
 * 复用这份常量的 key / zh / en / hex / keywords，禁止在别处硬编码色值。
 * keywords 匹配规则：中文关键词按子串匹配；纯 ASCII 关键词按「单词边界」匹配
 * （避免 ai 命中 chain / detail 之类的误判）。打分 = 标题命中数 ×2 + 概述命中数
 * （标题短而具体，更能定性），分数最高的分类胜出，同分按本表声明顺序取先者；
 * 一个都不命中 → 返回空串 = 不上色，回到元素类型默认色。
 */
const DEV_FUNC_COLORS = [
  {
    key: "core",
    zh: "核心运行时",
    en: "Core runtime",
    hex: "#6db4ff",
    keywords: [
      "主进程", "外壳", "启动", "引导", "状态机", "运行时", "内核", "窗口",
      "菜单", "快捷键", "撤销", "编辑器", "引擎",
      "main", "main-process", "shell", "bootstrap", "startup", "runtime",
      "kernel", "electron", "window", "menu", "hotkey", "shortcut",
      "undo", "redo", "core",
    ],
  },
  {
    key: "canvas",
    zh: "画布与交互",
    en: "Canvas & interaction",
    hex: "#45cfe6",
    keywords: [
      "画布", "连线", "排版", "标注", "主题", "交互", "组件", "弹层", "面板",
      "视图", "缩放", "拖拽", "框选",
      "canvas", "render", "renderer", "layout", "wire", "edge", "widget",
      "panel", "toolbar", "tooltip", "zoom", "drag", "theme", "marks", "ui",
      "ux", "css",
    ],
  },
  {
    key: "ai",
    zh: "AI 与 Agent",
    en: "AI & agents",
    hex: "#c792ea",
    keywords: [
      "智能体", "智能会话", "智能节点", "网关", "会话", "助手", "提示词",
      "大模型", "模型", "推理", "对话", "意图",
      "agent", "agents", "ai", "llm", "model", "models", "gateway", "session",
      "chat", "assistant", "prompt", "prompts", "reasoning", "token",
      "mcp", "dsh", "harness", "deepseek", "minimax",
    ],
  },
  {
    key: "data",
    zh: "数据与存储",
    en: "Data & storage",
    hex: "#4dd0c4",
    keywords: [
      "数据库", "存储", "持久化", "缓存", "配置", "设置", "导入", "导出",
      "备份", "副本", "数据表", "建表", "记录", "迁移",
      "database", "db", "sqlite", "fts", "storage", "persist", "cache",
      "config", "settings", "import", "export", "backup", "replica",
      "schema", "migration", "json", "yaml", "csv",
    ],
  },
  {
    key: "media",
    zh: "媒体与本地后端",
    en: "Media & local backends",
    hex: "#ff8fa3",
    keywords: [
      "文生图", "音乐", "视频", "图像", "图片", "音频", "语音", "显存",
      "后端", "权重", "补帧", "超分",
      "music", "video", "audio", "image", "images", "tts", "asr", "vram",
      "gpu", "comfyui", "backend", "ffmpeg", "voice", "thumbnail",
    ],
  },
  {
    key: "plugin",
    zh: "插件与生态",
    en: "Plugins & ecosystem",
    hex: "#f0c14d",
    keywords: [
      "插件", "技能", "扩展", "生态", "商店", "市场", "云端", "服务端",
      "套件",
      "plugin", "plugins", "extension", "extensions", "skill", "skills",
      "marketplace", "catalog", "store", "ecosystem", "server", "cloud",
      "registry",
    ],
  },
  {
    key: "build",
    zh: "构建与诊断",
    en: "Build & diagnostics",
    hex: "#ff9d5c",
    keywords: [
      "构建", "打包", "发布", "脚本", "更新", "升级", "日志", "诊断",
      "崩溃", "监控", "安装",
      "build", "bundle", "package", "packaging", "release", "script",
      "scripts", "npm", "vite", "electron-builder", "updater", "update",
      "changelog", "log", "logs", "diagnostic", "diagnostics", "crash",
      "deploy", "ci",
    ],
  },
  {
    key: "test",
    zh: "测试与质量",
    en: "Tests & quality",
    hex: "#a8e05f",
    keywords: [
      "测试", "冒烟", "断言", "覆盖率", "用例", "质检", "回归",
      "test", "tests", "testing", "smoke", "lint", "coverage", "assert",
      "assertion", "spec", "fixture", "mock", "e2e", "regression", "qa",
    ],
  },
];

/* 分类展示名（中 / 英文跟随当前语言；en 文案与 i18n.js「功能色卡」条目一致） */
function devFuncCatName(cat) {
  if (!cat) return "";
  const zh = String(cat.zh || cat.key || "");
  const en = String(cat.en || zh);
  try {
    if (typeof I18n !== "undefined" && I18n.getLocale && I18n.getLocale() === "en")
      return en;
  } catch (_) {}
  return zh;
}

/* 自定义外框色：合法 #rrggbb 返回小写 hex，否则空串（= 元素类型默认色） */
function devColorOf(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  const c = node && node.devColor;
  return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)
    ? c.toLowerCase()
    : "";
}

/* ---- 功能归类推断（标题 + 概述做关键词匹配） ---- */
/* ASCII 关键词要转成正则做单词边界匹配；中文关键词直接子串匹配 */
const _devFuncKwCache = new Map();
function devFuncKeywordRe(kw) {
  const cache = _devFuncKwCache;
  if (cache.has(kw)) return cache.get(kw);
  let re = null;
  if (/^[\x00-\x7F]*$/.test(kw)) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /* 词边界含 "-"：electron-builder 这类带连字符的词仍算整词命中 */
    re = new RegExp("(^|[^a-z0-9])" + esc + "($|[^a-z0-9])", "i");
  }
  cache.set(kw, re);
  return re;
}

/* 单类关键词在一小段文本里的命中次数 */
function devFuncHits(text, cat) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kwRaw of cat.keywords || []) {
    const kw = String(kwRaw || "").trim();
    if (!kw) continue;
    const re = devFuncKeywordRe(kw);
    if (re ? re.test(text) : lower.includes(kw.toLowerCase())) hits += 1;
  }
  return hits;
}

/* 命中的功能分类 key（core / canvas / …）；未命中返回空串 = 不上色。
 * 打分：标题命中权重 2、概述命中权重 1（标题短而具体，更能定性）；
 * 同分按 DEV_FUNC_COLORS 声明顺序取先者。 */
function devFuncGuess(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  const title = String(node.title || "").trim();
  const note = String(node.note || "").trim();
  if (!title && !note) return "";
  let bestKey = "";
  let bestScore = 0;
  for (const cat of DEV_FUNC_COLORS) {
    const score = devFuncHits(title, cat) * 2 + devFuncHits(note, cat);
    if (score > bestScore) {
      bestScore = score;
      bestKey = cat.key;
    }
  }
  return bestScore > 0 ? bestKey : "";
}

/* 功能色（推断出的 #rrggbb）：仅 module 功能块参与，未归类返回空串。
 * 用户已手选颜色时返回空串——devColorOf 优先级最高，推断只填「空值」。 */
function devFuncColorOf(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  if ((devKindOf(node) || "module") !== "module") return "";
  if (devColorOf(node)) return "";
  const cat = DEV_FUNC_COLORS.find((c) => c.key === devFuncGuess(node));
  const hex = cat && typeof cat.hex === "string" ? cat.hex.toLowerCase() : "";
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : "";
}

/* 创建开发节点时按功能色卡自动上色：把推断出的功能色**写入** node.devColor，
 * 之后随工作流持久化，用户仍可在色板里手选覆盖。
 * 生效条件（全部满足才上色）：
 *   · 是 dev 超级节点且不是 db 节点；
 *   · devKind = module（file / class / interface / enum 保留元素类型默认色）；
 *   · devColor 为空——调用方显式传过 devColor 时优先级最高，一律不覆盖。
 * 两个创建入口都调它：Agent 的 canvas_edit create（app-nodes.js）与右键
 * 「开发节点（功能块）」菜单（app.js addNode）。未归类（关键词不命中）的块
 * 返回空串 = 不上色，继续显示 module 的类型默认色。
 * 返回实际写入的 hex（空串 = 未上色）。 */
function devAutoColorNode(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  if (devColorOf(node)) return "";
  if ((devKindOf(node) || "module") !== "module") return "";
  const hex = devFuncColorOf(node);
  if (!hex) return "";
  node.devColor = hex;
  return hex;
}

/* 当前应显示的颜色：自定义优先，否则按元素类型默认 */
function devShownColor(node) {
  return devColorOf(node) || DEV_KIND_COLOR[devKindOf(node)] || DEV_KIND_COLOR.module;
}

/* hex → "r, g, b"（CSS --dev-glow 需要 RGB 三元组）；无效返回 null */
function hexToRgbTriplet(hex) {
  if (!(typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex))) return null;
  const n = parseInt(hex.slice(1), 16);
  return (
    ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255)
  );
}

/* ---- HSV ↔ RGB / HEX ---- */
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, Number(s) || 0));
  v = Math.max(0, Math.min(1, Number(v) || 0));
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}
function rgbToHsv(r, g, b) {
  r = Math.max(0, Math.min(255, Number(r) || 0)) / 255;
  g = Math.max(0, Math.min(255, Number(g) || 0)) / 255;
  b = Math.max(0, Math.min(255, Number(b) || 0)) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}
function hsvToHex(h, s, v) {
  const o = hsvToRgb(h, s, v);
  return (
    "#" +
    ((1 << 24) | (o.r << 16) | (o.g << 8) | o.b).toString(16).slice(1).toLowerCase()
  );
}
function hexToHsv(hex) {
  if (!(typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)))
    return { h: 0, s: 0, v: 1 };
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/* ---- 菜单栏按钮 ---- */
/* 颜色小按钮：圆点 = 当前色（自定义或元素类型默认）；点击切换 HSV 色板 */
function devColorButtonEl(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "n-dev-color" + (devColorOf(node) ? " custom" : "");
  btn.innerHTML = '<span class="dot" aria-hidden="true"></span>';
  btn.title = I18n.t("节点颜色：点击展开 HSV 色板，手动修改外框与呼吸灯颜色");
  if (typeof btn.setAttribute === "function") btn.setAttribute("aria-label", btn.title);
  const dot = btn.querySelector(".dot");
  if (dot) dot.style.background = devShownColor(node);
  btn.onclick = (ev) => {
    ev.stopPropagation();
    toggleDevColorPicker(node, btn);
  };
  return btn;
}

/* 颜色变化后刷新按钮圆点（就地更新，不整板重绘，色板不被打断） */
function devColorButtonRefresh(node) {
  const btn = document.querySelector(
    '.wf-node[data-nid="' + node.id + '"] .n-dev-color',
  );
  if (!btn) return;
  const dot = btn.querySelector(".dot");
  if (dot) dot.style.background = devShownColor(node);
  btn.classList.toggle("custom", !!devColorOf(node));
}

/* 把节点当前 devColor 应用到其 DOM 元素（外框色 / 呼吸灯光晕） */
function applyDevColorToEl(node) {
  const el = document.querySelector('.wf-node[data-nid="' + node.id + '"]');
  if (!el) return;
  const c = devColorOf(node);
  el.classList.toggle("dev-custom-color", !!c);
  if (c) {
    el.style.setProperty("--dev-color", c);
    const rgb = hexToRgbTriplet(c);
    if (rgb) el.style.setProperty("--dev-glow", rgb);
    else el.style.removeProperty("--dev-glow");
  } else {
    el.style.removeProperty("--dev-color");
    el.style.removeProperty("--dev-glow");
  }
}

/* ---- HSV 色板弹出层（id=devColorPop，fixed 定位，跟随按钮） ---- */
let _devColorHSV = { h: 0, s: 1, v: 1 }; /* 编辑中的 HSV */
let _devColorNode = null;                /* 正在编辑的节点 */

function devColorPopEl() {
  let el = document.getElementById("devColorPop");
  if (el) return el;
  el = document.createElement("div");
  el.id = "devColorPop";
  el.className = "dev-color-pop";
  el.innerHTML =
    '<div class="dev-color-head"><b></b><button type="button" class="mini" data-act="close">✕</button></div>' +
    /* 功能色卡快捷行：与自动上色同一张色卡，一眼看懂 + 一键覆盖 */
    '<div class="dev-color-func">' +
    '<div class="dev-color-func-head"><b></b><span class="hint"></span></div>' +
    '<div class="dev-color-func-row"></div>' +
    "</div>" +
    '<div class="dev-color-canvas">' +
    '<canvas class="dev-color-sv" width="180" height="180"></canvas>' +
    '<canvas class="dev-color-hue" width="180" height="16"></canvas>' +
    "</div>" +
    '<div class="dev-color-row">' +
    '<span class="dev-color-swatch" aria-hidden="true"></span>' +
    '<input type="text" class="dev-color-hex" spellcheck="false" maxlength="7"/>' +
    '<span class="dev-color-rgb"></span>' +
    "</div>" +
    '<div class="dev-color-actions">' +
    '<button type="button" class="mini" data-act="reset"></button>' +
    '<button type="button" class="mini" data-act="done"></button>' +
    "</div>";
  document.body.appendChild(el);
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.querySelector('[data-act="close"]').onclick = () => closeDevColorPicker();
  el.querySelector('[data-act="done"]').onclick = () => closeDevColorPicker();
  el.querySelector('[data-act="reset"]').onclick = () => {
    pushHistory();
    _devColorNode.devColor = "";
    devColorSyncAll();
  };
  /* 功能色卡快捷行：8 个分类色 swatch，点击即手动套用（色值 / 名称均取自
     DEV_FUNC_COLORS 唯一真源，不在此硬编码） */
  const funcRow = el.querySelector(".dev-color-func-row");
  if (funcRow) {
    for (const cat of DEV_FUNC_COLORS) {
      const hex = String(cat.hex || "").toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hex)) continue;
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "dev-color-func-sw";
      sw.dataset.hex = hex;
      sw.dataset.cat = String(cat.key || "");
      sw.style.background = hex;
      sw.onclick = (ev) => {
        ev.stopPropagation();
        if (!_devColorNode) return;
        if (devColorOf(_devColorNode) === hex) return; /* 已是当前色：不留冗余历史 */
        pushHistory();
        _devColorNode.devColor = hex;
        devColorSyncAll();
        scheduleSave();
      };
      funcRow.appendChild(sw);
    }
  }
  /* 方块拖动（饱和度 × 明度） */
  const svC = el.querySelector(".dev-color-sv");
  const hueC = el.querySelector(".dev-color-hue");
  const svPos = (ev) => {
    const r = svC.getBoundingClientRect();
    _devColorHSV.s = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    _devColorHSV.v = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
  };
  const huePos = (ev) => {
    const r = hueC.getBoundingClientRect();
    _devColorHSV.h = Math.max(0, Math.min(360, ((ev.clientX - r.left) / r.width) * 360));
  };
  const drag = (ev, fn) => {
    fn(ev);
    _devColorNode.devColor = hsvToHex(_devColorHSV.h, _devColorHSV.s, _devColorHSV.v);
    devColorSyncAll();
    scheduleSave();
  };
  svC.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    svC.setPointerCapture(ev.pointerId);
    drag(ev, svPos);
  });
  svC.addEventListener("pointermove", (ev) => {
    if (svC.hasPointerCapture(ev.pointerId)) drag(ev, svPos);
  });
  svC.addEventListener("pointerup", (ev) => {
    if (svC.hasPointerCapture(ev.pointerId)) svC.releasePointerCapture(ev.pointerId);
  });
  hueC.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    hueC.setPointerCapture(ev.pointerId);
    drag(ev, huePos);
  });
  hueC.addEventListener("pointermove", (ev) => {
    if (hueC.hasPointerCapture(ev.pointerId)) drag(ev, huePos);
  });
  hueC.addEventListener("pointerup", (ev) => {
    if (hueC.hasPointerCapture(ev.pointerId)) hueC.releasePointerCapture(ev.pointerId);
  });
  /* 直接输入 Hex */
  const hexIn = el.querySelector(".dev-color-hex");
  const commitHex = () => {
    const v = String(hexIn.value || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
      toast(I18n.t("无效的 Hex 颜色（示例：#6FE3A5）"), "warn");
      syncDevColorFields();
      return;
    }
    pushHistory();
    _devColorHSV = hexToHsv(v);
    _devColorNode.devColor = v.toLowerCase();
    devColorSyncAll();
    scheduleSave();
  };
  hexIn.addEventListener("change", commitHex);
  hexIn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitHex();
    }
  });
  return el;
}

/* 功能色卡快捷行：小标题 + 每个 swatch 的 tooltip（分类名 + hex）+ 当前色高亮。
 * 由 syncDevColorFields 调用，颜色或语言变化都会就地刷新。 */
function syncDevColorFuncRow(el) {
  const box = el.querySelector(".dev-color-func");
  if (!box) return;
  const title = box.querySelector(".dev-color-func-head b");
  if (title) title.textContent = I18n.t("功能色卡");
  const hint = box.querySelector(".dev-color-func-head .hint");
  if (hint) hint.textContent = I18n.t("按功能上色");
  const cur = devColorOf(_devColorNode);
  const sws = el.querySelectorAll(".dev-color-func-sw");
  for (let i = 0; i < sws.length; i++) {
    const sw = sws[i];
    const hex = String(sw.dataset.hex || "");
    const cat = DEV_FUNC_COLORS.find((c) => String(c.hex || "").toLowerCase() === hex);
    const tip = devFuncCatName(cat) + " · " + hex.toUpperCase();
    sw.title = tip;
    if (typeof sw.setAttribute === "function") sw.setAttribute("aria-label", tip);
    sw.classList.toggle("on", !!cur && cur === hex);
  }
}

/* 弹出层控件同步到节点当前值（色板 canvas / 色块 / Hex / RGB 文本） */
function syncDevColorFields() {
  const el = document.getElementById("devColorPop");
  if (!el) return;
  _devColorHSV = hexToHsv(devColorOf(_devColorNode) || devShownColor(_devColorNode));
  renderDevColorCanvases(el);
  syncDevColorFuncRow(el);
  const hex = hsvToHex(_devColorHSV.h, _devColorHSV.s, _devColorHSV.v);
  const sw = el.querySelector(".dev-color-swatch");
  if (sw) sw.style.background = hex;
  const hexIn = el.querySelector(".dev-color-hex");
  if (hexIn) hexIn.value = hex.toUpperCase();
  const rgbT = el.querySelector(".dev-color-rgb");
  if (rgbT) {
    const o = hsvToRgb(_devColorHSV.h, _devColorHSV.s, _devColorHSV.v);
    rgbT.textContent = "rgb(" + o.r + ", " + o.g + ", " + o.b + ")";
  }
}

/* 颜色变化后统一落地：节点 DOM（外框/呼吸灯）+ 按钮圆点 + 弹出层控件 */
function devColorSyncAll() {
  devColorButtonRefresh(_devColorNode);
  applyDevColorToEl(_devColorNode);
  syncDevColorFields();
}

/* 重绘两张 canvas（SV 方块 + 色相条）与选中标记 */
function renderDevColorCanvases(el) {
  const svC = el.querySelector(".dev-color-sv");
  const hueC = el.querySelector(".dev-color-hue");
  if (svC && typeof svC.getContext === "function") {
    const ctx = svC.getContext("2d");
    const W = svC.width, H = svC.height;
    const o = hsvToRgb(_devColorHSV.h, 1, 1);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(1, "rgb(" + o.r + "," + o.g + "," + o.b + ")");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const black = ctx.createLinearGradient(0, 0, 0, H);
    black.addColorStop(0, "rgba(0,0,0,0)");
    black.addColorStop(1, "rgba(0,0,0,1)");
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, W, H);
    const mx = _devColorHSV.s * W;
    const my = (1 - _devColorHSV.v) * H;
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (hueC && typeof hueC.getContext === "function") {
    const ctx = hueC.getContext("2d");
    const W = hueC.width, H = hueC.height;
    for (let x = 0; x < W; x++) {
      const o = hsvToRgb((x / W) * 360, 1, 1);
      ctx.fillStyle = "rgb(" + o.r + "," + o.g + "," + o.b + ")";
      ctx.fillRect(x, 0, 1, H);
    }
    const hx = (_devColorHSV.h / 360) * W;
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, H);
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/* 打开色板：fixed 定位到按钮下方（贴边防溢出） */
function openDevColorPop(node, anchor) {
  _devColorNode = node;
  const el = devColorPopEl();
  el.querySelector(".dev-color-head b").textContent = I18n.t("节点颜色");
  el.querySelector('[data-act="reset"]').textContent = I18n.t("恢复元素类型默认色");
  el.querySelector('[data-act="done"]').textContent = I18n.t("完成");
  el.classList.add("on");
  const r = anchor.getBoundingClientRect();
  const pad = 8;
  /* 弹层尺寸实测（新增功能色卡快捷行后高度变大；兜底值同步上调） */
  const w = el.offsetWidth || 200;
  let left = r.left;
  let top = r.bottom + 6;
  const h = el.offsetHeight || 386;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
  syncDevColorFields();
  devColorButtonRefresh(node);
}

function closeDevColorPicker() {
  S.uiDevColorNode = null;
  _devColorNode = null;
  const el = document.getElementById("devColorPop");
  if (el) el.classList.remove("on");
}

function toggleDevColorPicker(node, anchor) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return;
  if (S.uiDevColorNode === node.id) {
    closeDevColorPicker();
    return;
  }
  pushHistory();
  S.uiDevColorNode = node.id;
  openDevColorPop(node, anchor);
}
/* ============ 开发节点 Agent 设定：菜单栏按钮 + 预设 / 模型 / 思考强度弹层 ============
 * 需求：开发节点上加「Agent 设定」选择按钮——选定后，本功能块以及**未自行选择**的
 * 子功能块，其所有 Agent 衍生功能（「建议」只读调研、「开发 / 细化」绑定会话）都用
 * 这个设定；子块自己选过就以子块为准（就近覆盖，不再向上继承）。
 * 数据：node.devModel（模型 id；空 = 未选择，跟随默认）+ node.devProvider（智能路由
 * id，可由模型自动推断），随工作流保存、canvas_get 可见、Agent 也能改。
 * node.devPreset（预设档 id，与会话同一张 AGENT_PRESETS 表）+ node.devEffort
 * （思考强度：档位词汇表内值 low/medium/high/xhigh/max，UI 露出 low/high/xhigh/max）
 * 同沿一条就近继承链，空 = 跟随默认。
 * 解析：devAgentSettingsOf(node) 沿 parentSuperId 就近向上找第一个已选值
 * （model / preset / effort 各自独立就近，子块自选优先）；devAgentModelOf 保留为
 * 只管模型的薄封装，不打断既有调用。
 */

/* 当前可用的智能路由（DeepSeek 官方 + 已配置的其它文本服务商） */
function devAgentRoutes() {
  const out = ["deepseek-official"];
  const add = (r) => {
    const v = String(r || "").trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  };
  try {
    if (typeof agentRouteOptions === "function") {
      const s = agentRouteOptions();
      if (s && typeof s.forEach === "function") {
        s.forEach((r) => add(r));
        return out;
      }
      if (Array.isArray(s)) {
        s.forEach((r) => add(r));
        return out;
      }
    }
    if (typeof mtnodePiProviders === "function") {
      for (const p of mtnodePiProviders() || []) add("mtnode_" + p.route);
    }
  } catch (_) {}
  return out;
}

/* 路由的展示名（服务商名） */
function devAgentRouteName(route) {
  const r = String(route || "").trim() || "deepseek-official";
  try {
    if (r === "deepseek-official") {
      const dp = typeof dshProvider === "function" ? dshProvider() : null;
      return (dp && dp.name) || I18n.t("DeepSeek 官方");
    }
    if (typeof providerForAgentRoute === "function") {
      const p = providerForAgentRoute(r);
      if (p && p.name) return String(p.name);
    }
    if (typeof mtnodePiProviders === "function") {
      const mp = (mtnodePiProviders() || []).find(
        (x) => "mtnode_" + x.route === r,
      );
      if (mp && mp.name) return String(mp.name);
    }
  } catch (_) {}
  return r;
}

/* 可选模型分组：[{ id: 路由, name: 服务商名, models: [模型 id] }] */
function devAgentModelGroups() {
  const out = [];
  for (const r of devAgentRoutes()) {
    let models = [];
    try {
      if (typeof agentModelsForRoute === "function")
        models = (agentModelsForRoute(r) || []).map(String);
    } catch (_) {
      models = [];
    }
    out.push({ id: r, name: devAgentRouteName(r), models });
  }
  return out;
}

/* 模型是否属于该路由（容忍大小写与「厂商/模型」前缀写法；路由未登记模型时不否决） */
function devModelFitsRoute(route, model) {
  const m = String(model || "").trim();
  if (!m) return false;
  const g = devAgentModelGroups().filter((x) => x.id === String(route || ""))[0];
  const models = (g && g.models) || [];
  if (!models.length) return true;
  const low = m.toLowerCase();
  return models.some((x) => {
    const s = String(x);
    return (
      s === m ||
      s.toLowerCase() === low ||
      s.endsWith("/" + low) ||
      s.endsWith(low)
    );
  });
}

/* 反查模型所属路由（都没登记 → 空串） */
function devRouteOfModel(model) {
  const m = String(model || "").trim();
  if (!m) return "";
  const low = m.toLowerCase();
  for (const g of devAgentModelGroups()) {
    const hit = (g.models || []).some(
      (x) => String(x).toLowerCase() === low || String(x) === m,
    );
    if (hit) return g.id;
  }
  return "";
}

/* 本节点自己选定的模型：{ provider, model }；未选 → null。
   服务商缺失 / 与模型不匹配时按模型表纠正路由（模型才是用户真正关心的字段） */
function devModelOwn(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return null;
  const m = String(node.devModel || "").trim();
  if (!m) return null;
  const routes = devAgentRoutes();
  let r = String(node.devProvider || "").trim();
  if (r && routes.indexOf(r) < 0) r = "";
  if (r && devModelFitsRoute(r, m)) return { provider: r, model: m };
  const found = devRouteOfModel(m);
  return { provider: found || r || "deepseek-official", model: m };
}

/* 预设档位归一 + 在册校验（含旧 id：sketch → lean）；未知 → 空串。
   真源仍是 app.js 的 AGENT_PRESETS，这里只查不抄。 */
function devPresetKnown(id) {
  let raw = String(id == null ? "" : id).trim();
  if (!raw) return "";
  if (typeof agentPresetId === "function") raw = String(agentPresetId(raw));
  if (typeof AGENT_PRESETS === "undefined" || !Array.isArray(AGENT_PRESETS))
    return raw;
  return AGENT_PRESETS.some((p) => String(p.id) === raw) ? raw : "";
}

/* 本节点自己选定的预设档；未选 / 未知 → 空串 */
function devPresetOwn(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  return devPresetKnown(node.devPreset);
}

/* 思考强度：只认档位词汇表内值（AGENT_EFFORT_ORDER = low/medium/high/xhigh/max，与会话
   同一张思考档表，见 app.js；medium 也是合法词汇，只是不露出 UI），其余值（off/none/
   无/空 与未知）一律不记录。默认档 = high（标准），网关对不支持的路由做同侧最近低档夹紧。 */
function devEffortKnown(v) {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  if (typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)) {
    return AGENT_EFFORT_ORDER.indexOf(s) >= 0 ? s : "";
  }
  return s === "low" || s === "medium" || s === "high" || s === "xhigh" || s === "max"
    ? s
    : "";
}

function devEffortOwn(node) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return "";
  return devEffortKnown(node.devEffort);
}

/* 预设 / 思考强度的展示名（app-assist.js 的 agentPresetLabel 可用就用它，
   否则退回查表；沙箱与单测里没有 assist 模块也能跑） */
function devPresetName(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  if (typeof agentPresetLabel === "function") {
    try {
      const t = agentPresetLabel(raw);
      if (t) return String(t);
    } catch (_) {}
  }
  if (typeof agentPresetById === "function") {
    const p = agentPresetById(raw);
    if (p && p.labelKey) return I18n.t(p.labelKey);
  }
  return raw;
}

/* 思考强度展示：与会话同一套档位表（app.js 的 AGENT_EFFORT_LABELS：low=轻、
   medium=中、high=标准、xhigh=强、max=最强；空 = 跟随默认 high → 标准）。选哪档就按哪档跑
   （预设不再压档，也不再需要「名义档 / 生效档」两套名）。 */
function devEffortName(st) {
  const s = st || {};
  if (typeof agentEffortDisplayLabel === "function") {
    try {
      const t = agentEffortDisplayLabel(s);
      if (t) return String(t);
    } catch (_) {}
  }
  if (typeof agentEffortLabelOf === "function") {
    try {
      const t = agentEffortLabelOf(s.effort);
      if (t) return String(t);
    } catch (_) {}
  }
  const label =
    (typeof AGENT_EFFORT_LABELS !== "undefined" && AGENT_EFFORT_LABELS) || {};
  const name = label[String(s.effort || "").trim().toLowerCase()];
  if (name) return I18n.t(name);
  if (s.effort === "max") return I18n.t("最强");
  if (s.effort === "xhigh") return I18n.t("强");
  if (s.effort === "medium") return I18n.t("中");
  if (s.effort === "low") return I18n.t("轻");
  return I18n.t("标准");
}

/* 预设短名（只用于节点按钮这类窄位置）：去掉档位名尾部的「模式」，
   文案真源仍是 AGENT_PRESETS 的 labelKey，这里只做裁剪、不另立名字 */
function devPresetShortName(id) {
  const t = String(devPresetName(id) || "").trim();
  if (!t) return "";
  const cut = t.replace(/\s*[（(].*$/, "").replace(/模式$/, "");
  return cut.trim() || t;
}

/* 思考强度短标（按钮用，与会话语义同源）：low → 轻、medium → 中、high（含未选默认）
   → 标、xhigh → 强、max → 最强。词条复用时注意「强」现在是共享档位表里 xhigh 档的
   短名（不再只指 max 的旧短标），max 用「最强」。 */
function devEffortShortTag(st) {
  const s = st || {};
  const e = String(s.effort || "").trim().toLowerCase();
  if (e === "low") return I18n.t("轻");
  if (e === "medium") return I18n.t("中");
  if (e === "xhigh") return I18n.t("强");
  if (e === "max") return I18n.t("最强");
  return I18n.t("标");
}

/* 生效的 Agent 设定：{ provider, model, preset, effort, source, inherited, … }
   四项各自沿 parentSuperId 就近向上找第一个已选值（互不牵连：可以整棵树统一模型、
   只在某个子块换预设）。source / inherited 说的是「模型」的来源，保持旧口径。 */
function devAgentSettingsOf(node) {
  const out = {
    provider: "",
    model: "",
    preset: "",
    effort: "",
    source: null,
    inherited: false,
    presetSource: null,
    presetInherited: false,
    effortSource: null,
    effortInherited: false,
  };
  if (!node || node.kind !== "super" || !node.dev || node.db) return out;
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 64) {
    if (!out.model) {
      const own = devModelOwn(cur);
      if (own) {
        out.provider = own.provider;
        out.model = own.model;
        out.source = cur;
        out.inherited = cur !== node;
      }
    }
    if (!out.preset) {
      const p = devPresetOwn(cur);
      if (p) {
        out.preset = p;
        out.presetSource = cur;
        out.presetInherited = cur !== node;
      }
    }
    if (!out.effort) {
      const e = devEffortOwn(cur);
      if (e) {
        out.effort = e;
        out.effortSource = cur;
        out.effortInherited = cur !== node;
      }
    }
    if (out.model && out.preset && out.effort) break;
    const pid =
      typeof nodeParentSuperId === "function"
        ? nodeParentSuperId(cur)
        : cur.parentSuperId;
    const parent =
      pid && typeof nodeById === "function" ? nodeById(pid) : null;
    cur = parent && parent.dev && !parent.db ? parent : null;
  }
  return out;
}

/* 生效模型：自身已选 → 否则就近向上找祖先功能块；都没选 → null（跟随默认）。
   薄封装：只关心模型的旧调用（按钮 / 弹层 / 会话入口）一律走它，语义不变。 */
function devAgentModelOf(node) {
  const s = devAgentSettingsOf(node);
  if (!s.model) return null;
  return {
    provider: s.provider,
    model: s.model,
    source: s.source,
    inherited: s.inherited,
  };
}

/* 生效模型的展示文本："服务商 · 模型"；未选择 → 空串 */
function devAgentModelText(node) {
  const eff = devAgentModelOf(node);
  return eff ? devAgentRouteName(eff.provider) + " · " + eff.model : "";
}

/* 弹层顶部一句话说明：pane = "preset" | "model" | "effort"，说清「这一格现在
   生效的是什么、是谁定的」（继承时点名上层功能块），未选则说明跟随默认。 */
function devScopeLine(value, srcNode, inherited, unsetText) {
  if (!value) return unsetText;
  if (inherited)
    return (
      I18n.t("当前继承自「") +
      ((srcNode && (srcNode.title || srcNode.id)) || "") +
      I18n.t("」：") +
      value +
      I18n.t("；在此单独选择后，本功能块及其子树改用它。")
    );
  return (
    I18n.t("本功能块已选择：") +
    value +
    I18n.t("；其下未自行选择的子功能块一并使用它。")
  );
}

/* 思考强度一栏：预设不管这一档（历史上会压到 low，现已取消），
   所以格子里说的就是本轮实际下发的那一档，只在选过时点名来源。 */
function devEffortScopeText(node) {
  const s = devAgentSettingsOf(node);
  if (!s.effort) return I18n.t("未选择：跟随默认思考档（标准）。");
  return (
    I18n.t("思考强度：") +
    devEffortName({ effort: s.effort }) +
    devInheritSuffix(s.effortSource, node)
  );
}

function devModelScopeText(node, pane) {
  const p = String(pane || "model");
  if (p === "effort") return devEffortScopeText(node);
  const s = devAgentSettingsOf(node);
  if (p === "preset")
    return devScopeLine(
      s.preset ? devPresetName(s.preset) : "",
      s.presetSource,
      s.presetInherited,
      I18n.t(
        "未选择：本功能块与子功能块的「建议 / 开发 / 细化」跟随默认预设。",
      ),
    );
  const eff = devAgentModelOf(node);
  return devScopeLine(
    eff ? devAgentRouteName(eff.provider) + " · " + eff.model : "",
    eff && eff.source,
    !!(eff && eff.inherited),
    I18n.t(
      "未选择：本功能块与子功能块的「建议 / 开发 / 细化」跟随默认模型。",
    ),
  );
}

/* 对话框里的一行展示：已选（含继承标注）/ 未选（自动跟随默认） */
function devModelDialogText(node) {
  const eff = devAgentModelOf(node);
  if (!eff) return I18n.t("自动（跟随默认）");
  return (
    devAgentRouteName(eff.provider) +
    " · " +
    eff.model +
    (eff.inherited
      ? I18n.t("（继承自「") +
        (eff.source.title || eff.source.id) +
        I18n.t("」）")
      : "")
  );
}

/* 继承来源后缀：谁定的这一档（上层功能块定的要点名，便于回溯） */
function devInheritSuffix(srcNode, node) {
  if (!srcNode || srcNode === node) return "";
  return I18n.t("（继承自「") + (srcNode.title || srcNode.id) + I18n.t("」）");
}

/* 对话框「Agent 预设」一行：已选（含继承标注）/ 未选（自动跟随默认） */
function devPresetDialogText(node) {
  const s = devAgentSettingsOf(node);
  if (!s.preset) return I18n.t("自动（跟随默认）");
  return devPresetName(s.preset) + devInheritSuffix(s.presetSource, node);
}

/* 对话框「Agent 思考强度」一行：本块没选（也没继承到）就写自动跟随默认；
   选过就写那一档 —— 预设不再改写思考档，名义档即生效档。 */
function devEffortDialogText(node) {
  const s = devAgentSettingsOf(node);
  if (!s.effort) return I18n.t("自动（跟随默认）");
  return devEffortName({ effort: s.effort }) + devInheritSuffix(s.effortSource, node);
}

/* ---- 菜单栏按钮：显示当前生效的 Agent 设定，点击展开「预设 / 模型 / 思考强度」弹层 ---- */

/* 按钮文字摘要：模型打头，选过预设 / 思考档再追加短标签；全未选 → 「自动」 */
function devModelButtonLabel(node) {
  const s = devAgentSettingsOf(node);
  const parts = [s.model || I18n.t("自动")];
  if (s.preset) parts.push(devPresetShortName(s.preset));
  if (s.effort) parts.push(devEffortShortTag({ effort: s.effort }));
  return parts.filter(Boolean).join(" · ");
}

/* auto = 三格都没定（跟随默认）；inherited = 模型来自上层功能块（虚线） */
function devModelButtonClass(node, eff) {
  const s = devAgentSettingsOf(node);
  if (eff) return "n-dev-model" + (eff.inherited ? " inherited" : "");
  return "n-dev-model" + (s.preset || s.effort ? "" : " auto");
}

function devModelButtonTitle(node, eff) {
  let t;
  if (!eff)
    t = I18n.t(
      "Agent 模型：自动（跟随默认）· 点击选择；选定后本功能块与未自行选择的子功能块都会用它",
    );
  else {
    const m = devAgentRouteName(eff.provider) + " · " + eff.model;
    if (eff.inherited)
      t =
        I18n.t("Agent 模型：") +
        m +
        I18n.t("（继承自「") +
        (eff.source.title || eff.source.id) +
        I18n.t("」）· 点击为本功能块单独选择");
    else
      t =
        I18n.t("Agent 模型：") +
        m +
        I18n.t(" · 点击修改（未自行选择的子功能块会继承）");
  }
  /* 预设与思考档也进提示：三格都是就近继承的，光看模型看不出这轮会怎么跑 */
  return (
    t +
    "\n" +
    I18n.t("Agent 预设：") +
    devPresetDialogText(node) +
    "\n" +
    I18n.t("思考强度：") +
    devEffortDialogText(node)
  );
}

function devModelButtonEl(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  const eff = devAgentModelOf(node);
  btn.className = devModelButtonClass(node, eff);
  const ico = devDlgEl("span", "ico", "🧠");
  const lbl = devDlgEl("span", "lbl", devModelButtonLabel(node));
  btn.appendChild(ico);
  btn.appendChild(lbl);
  btn.title = devModelButtonTitle(node, eff);
  if (typeof btn.setAttribute === "function")
    btn.setAttribute("aria-label", btn.title);
  btn.onclick = (ev) => {
    ev.stopPropagation();
    toggleDevModelPicker(node, btn);
  };
  return btn;
}

/* 节点设定变了但整张画布还没重绘时，就地更新头部按钮 */
function devModelButtonRefresh(node) {
  if (!node) return;
  const el = document.querySelector(
    '.wf-node[data-nid="' + node.id + '"] .n-dev-model',
  );
  if (!el) return;
  const eff = devAgentModelOf(node);
  el.className = devModelButtonClass(node, eff);
  const lbl = el.querySelector(".lbl");
  if (lbl) lbl.textContent = devModelButtonLabel(node);
  const t = devModelButtonTitle(node, eff);
  el.title = t;
  if (typeof el.setAttribute === "function") el.setAttribute("aria-label", t);
}

/* ---- Agent 设定弹层（id=devModelPop，fixed 定位，跟随按钮）----
   头部三格 cell（预设 / 模型 / 思考强度）＝会话侧 buildAgentModelMenu 的
   cell + pane 语义：点某格就把下面的清单切成那一格的档位，格子上回显的是
   「本块 + 就近继承」的生效值（↩ = 来自上层功能块）。 */
let _devModelNode = null; /* 正在选择的节点 */
let _devModelPane = "model"; /* 当前格：preset | model | effort */

const DEV_AGENT_PANES = [
  { key: "preset", label: "预设" },
  { key: "model", label: "模型" },
  { key: "effort", label: "思考强度" },
];

function devAgentPaneLabel(key) {
  const p = DEV_AGENT_PANES.filter((x) => x.key === key)[0];
  return p ? p.label : "模型";
}

/* 三格各自回显的值：显示生效值（继承来的也要看得见），不是本块已存值 */
function devAgentPaneCell(node, pane) {
  const s = devAgentSettingsOf(node);
  if (pane === "preset")
    return {
      value: s.preset
        ? devPresetName(s.preset) + (s.presetInherited ? " ↩" : "")
        : I18n.t("自动"),
      tip: I18n.t("Agent 预设：") + devPresetDialogText(node),
    };
  if (pane === "effort")
    return {
      value: s.effort
        ? devEffortName({ effort: s.effort }) + (s.effortInherited ? " ↩" : "")
        : I18n.t("自动"),
      tip: I18n.t("思考强度：") + devEffortDialogText(node),
    };
  const eff = devAgentModelOf(node);
  return {
    value: eff ? eff.model + (eff.inherited ? " ↩" : "") : I18n.t("自动"),
    tip: I18n.t("Agent 模型：") + devModelDialogText(node),
  };
}

function renderDevAgentCells(cells, node) {
  cells.innerHTML = "";
  for (const p of DEV_AGENT_PANES) {
    const c = devAgentPaneCell(node, p.key);
    const b = devDlgEl(
      "button",
      "dev-model-cell pane-" + p.key + (p.key === _devModelPane ? " on" : ""),
      null,
    );
    b.type = "button";
    b.appendChild(devDlgEl("span", "dev-model-cell-label", I18n.t(p.label)));
    b.appendChild(devDlgEl("span", "dev-model-cell-value", c.value));
    b.appendChild(devDlgEl("span", "dev-model-cell-chevron", "›"));
    b.title = c.tip;
    const key = p.key;
    b.onclick = () => {
      _devModelPane = key;
      renderDevModelPop();
    };
    cells.appendChild(b);
  }
}

/* 弹层里的一个可选项（三格共用）：名称 +「继承」标注 + ✓ */
function devPopOption(list, text, on, onclick, tip, tag) {
  const b = devDlgEl("button", "dev-model-opt" + (on ? " on" : ""), null);
  b.type = "button";
  b.appendChild(devDlgEl("span", "m", text));
  if (tag) b.appendChild(devDlgEl("span", "i", tag));
  if (on) b.appendChild(devDlgEl("span", "c", "✓"));
  if (tip) b.title = tip;
  if (onclick) b.onclick = onclick;
  list.appendChild(b);
  return b;
}

/* 预设格：档位真源是 app.js 的 AGENT_PRESETS，这里只遍历，不自抄一份 */
function devRenderPresetPane(list, node) {
  const own = devPresetOwn(node);
  const s = devAgentSettingsOf(node);
  const inherited = !own && !!s.preset && !!s.presetInherited;
  devPopOption(
    list,
    I18n.t("跟随默认（不指定）"),
    !own,
    () => applyDevAgentSetting(node, "preset", ""),
    I18n.t("不指定：本功能块与未自行选择的子功能块跟随默认预设。"),
  );
  const presets =
    typeof AGENT_PRESETS !== "undefined" && Array.isArray(AGENT_PRESETS)
      ? AGENT_PRESETS
      : [];
  for (const p of presets) {
    devPopOption(
      list,
      I18n.t(p.labelKey),
      own === p.id,
      () => applyDevAgentSetting(node, "preset", p.id),
      p.hint ? I18n.t(p.hint) : "",
      inherited && s.preset === p.id ? I18n.t("（继承）") : "",
    );
  }
}

/* 思考强度格：与会话思考档菜单同一张表 —— 遍历 app.js 的 AGENT_EFFORT_UI_ORDER
   （低=轻 / high=标准 / xhigh=强 / max=最强；medium 是合法词汇但不露出：默认
   deepseek-official 路由会把 medium 按同侧最近低档夹到 low，露出会在默认路由静默降档）。
   预设不再压档（历史上思维精简会把标准降到 low），选项名就是实际下发的那一档。 */
function devRenderEffortPane(list, node) {
  const own = devEffortOwn(node);
  const uiOrder =
    typeof AGENT_EFFORT_UI_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_UI_ORDER)
      ? AGENT_EFFORT_UI_ORDER
      : ["low", "high", "xhigh", "max"];
  const labels = { low: "轻", high: "标准", xhigh: "强", max: "最强" };
  const maxTip = I18n.t("最强：推理预算最高（更慢、更费 token），不受任何预设影响");
  for (const v of uiOrder) {
    let label = "";
    if (typeof agentEffortLabelOf === "function") {
      try {
        label = String(agentEffortLabelOf(v));
      } catch (_) {}
    }
    devPopOption(
      list,
      label || I18n.t(labels[v] || "标准"),
      own === v,
      () => applyDevAgentSetting(node, "effort", v),
      v === "max" ? maxTip : "",
    );
  }
}

/* 模型格：按服务商分组的模型清单（本块自选项打勾，继承项由顶部说明点名） */
function devRenderModelPane(list, node) {
  const own = devModelOwn(node);
  const curKey = own ? own.provider + "|" + own.model : "";
  let any = 0;
  for (const g of devAgentModelGroups()) {
    const models = g.models || [];
    if (!models.length) continue;
    list.appendChild(devDlgEl("div", "dev-model-group", g.name));
    for (const m of models) {
      const on = curKey === g.id + "|" + m;
      const route = g.id;
      devPopOption(list, m, on, () =>
        applyDevAgentSetting(node, "model", m, route),
      );
      any++;
    }
  }
  if (!any)
    list.appendChild(
      devDlgEl(
        "div",
        "dev-model-empty",
        I18n.t("暂无可用模型：请先在 设置 → 模型服务 中添加服务商与模型。"),
      ),
    );
}

function devModelPopEl() {
  let el = document.getElementById("devModelPop");
  if (el) return el;
  el = document.createElement("div");
  el.id = "devModelPop";
  el.className = "dev-model-pop";
  const head = document.createElement("div");
  head.className = "dev-model-head";
  head.appendChild(devDlgEl("b", null, I18n.t("Agent 设定")));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mini dev-model-close";
  close.textContent = "✕";
  close.onclick = () => closeDevModelPicker();
  head.appendChild(close);
  const cells = document.createElement("div");
  cells.className = "dev-model-cells";
  const scope = document.createElement("div");
  scope.className = "dev-model-scope";
  const list = document.createElement("div");
  list.className = "dev-model-list";
  const foot = document.createElement("div");
  foot.className = "dev-model-actions";
  el.appendChild(head);
  el.appendChild(cells);
  el.appendChild(scope);
  el.appendChild(list);
  el.appendChild(foot);
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  document.body.appendChild(el);
  return el;
}

/* 重绘弹层：三格 + 本格现状说明 + 本格档位 + 本格「跟随默认」出口 */
function renderDevModelPop() {
  const el = document.getElementById("devModelPop");
  if (!el || !_devModelNode) return;
  const node = _devModelNode;
  const pane = _devModelPane;
  const cells = el.querySelector(".dev-model-cells");
  if (cells) renderDevAgentCells(cells, node);
  const scope = el.querySelector(".dev-model-scope");
  if (scope) scope.textContent = devModelScopeText(node, pane);
  const list = el.querySelector(".dev-model-list");
  if (list) {
    list.innerHTML = "";
    if (pane === "preset") devRenderPresetPane(list, node);
    else if (pane === "effort") devRenderEffortPane(list, node);
    else devRenderModelPane(list, node);
  }
  const foot = el.querySelector(".dev-model-actions");
  if (foot) {
    foot.innerHTML = "";
    const reset = devDlgEl(
      "button",
      "mini dev-model-reset",
      I18n.t("跟随默认（不指定）"),
    );
    reset.type = "button";
    reset.title =
      I18n.t("清除本功能块「") +
      I18n.t(devAgentPaneLabel(pane)) +
      I18n.t("」这一格的选择，退回跟随默认（或继承上层）。");
    reset.onclick = () => applyDevAgentSetting(node, pane, "");
    foot.appendChild(reset);
  }
}

/* 三格共用的写回：key = "preset" | "model" | "effort"（model 另带 route）；
   value 传空 = 清除本块选择。写节点 → 存盘 → 收起弹层 → 重绘画布。
   预设只认在册档位（旧 id 归一），思考档只认档位词汇表内值，脏值当清除处理。 */
function applyDevAgentSetting(node, key, value, route) {
  if (!node || node.kind !== "super" || !node.dev) return;
  const k = String(key || "model");
  pushHistory();
  if (k === "preset") node.devPreset = devPresetKnown(value);
  else if (k === "effort") node.devEffort = devEffortKnown(value);
  else {
    const m = String(value || "").trim();
    node.devModel = m;
    node.devProvider = m ? String(route || "").trim() : "";
  }
  scheduleSave(true);
  if (S.uiDevModelNode === node.id) closeDevModelPicker();
  devModelButtonRefresh(node);
  try {
    renderCanvas();
  } catch (_) {}
}

/* 旧入口：模型格的「选定 / 清除」，保留为薄封装（既有调用与冒烟测试不断） */
function applyDevModelChoice(node, route, model) {
  applyDevAgentSetting(node, "model", model, route);
}

/* 打开弹层：fixed 定位到按钮下方（贴边防溢出） */
function openDevModelPop(node, anchor) {
  _devModelNode = node;
  _devModelPane = "model"; /* 每次打开都落在最常用的模型格 */
  const el = devModelPopEl();
  el.classList.add("on");
  renderDevModelPop();
  const r = anchor.getBoundingClientRect();
  const pad = 8;
  const w = el.offsetWidth || 240;
  let left = r.left;
  let top = r.bottom + 6;
  const h = el.offsetHeight || 320;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function closeDevModelPicker() {
  S.uiDevModelNode = null;
  _devModelNode = null;
  const el = document.getElementById("devModelPop");
  if (el) el.classList.remove("on");
}

function toggleDevModelPicker(node, anchor) {
  if (!node || node.kind !== "super" || !node.dev || node.db) return;
  if (S.uiDevModelNode === node.id) {
    closeDevModelPicker();
    return;
  }
  S.uiDevModelNode = node.id;
  openDevModelPop(node, anchor);
}
