"use strict";
/* ============ 开发节点「建议」按钮 ============
 * 需求：开发节点（super + dev:true）增加「建议」按钮 —— 点击后同样先弹对话框，
 * 由用户确认后才让 AI 主动评估：读项目真实代码 + 该模块的开发进度，给出 4 条
 * 「下一步该实现什么」的方案；对话框里允许多选、允许用户补充；用户选完可以在
 * 同一个对话框里再点「开发」，等同于用当前勾选的建议 + 补充内容直接开工。
 *
 * 三段式（同一个对话框宿主 #mtDialog 内完成，不跳视图、不打断用户）：
 *   1) mtDialogForm 确认框：显示现状（类型 / 状态 / 项目根 / 子元素 / 历史会话 /
 *      上次建议），可选填「本轮关注点」→「确认生成建议」
 *   2) 只读调研中：实时显示 Agent 的工具调用（read/grep/git status…）与耗时，
 *      期间绝不写文件、不改画布（系统提示按规划模式的禁令约束）
 *   3) 方案清单：4 条（可多选 · 数字键 1-4 快速勾选）+ AI 评估摘要 + 真实证据
 *      +「补充说明」输入框 + 按钮「取消 / 换一批 / 开发」
 * 「开发」→ startDevSessionWithText()：与「开发」按钮完全同一条路径（新建绑定
 * 会话、状态转 wip、切到会话视图运行），只是任务正文由勾选结果拼出来。
 *
 * 结果缓存在节点上（node.devSuggest：items / summary / basis / at / picked /
 * supplement），随工作流保存；再次点「建议」可直接查看上次结果而不必重跑模型。
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

/* ---------- 进度上下文（喂给 AI 的「当前开发进度」） ---------- */
function devNodeBriefLine(n, mark) {
  const dk = devKindOf(n) || "module";
  const note = String(n.note || "").trim();
  return (
    (mark || "  - ") +
    (n.title || n.id) +
    "（" +
    I18n.t(DEV_KIND_LABEL[dk] || "模块") +
    " · " +
    devStatusText(devStatusOf(n)) +
    "）" +
    (note ? "：" + clipStr(note, 120) : "")
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
  lines.push(
    I18n.t("模块概述：") +
      (String(node.note || "").trim() ||
        I18n.t("（暂无概述 · 该块职责还没写清楚）")),
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
        "对照「模块概述」判断真实完成度：哪些职责已落地、哪些缺失或是半成品（TODO / 空实现 / 未接线的调用 / 缺错误处理 / 无测试）。",
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
        "若本模块其实已经完备，不要硬凑新功能：改为给出「下一步该做什么」（如细化下层元素、集成验证、性能与边界、补概述与文档），并在 summary 里说明现状。",
      ),
  );
  lines.push(
    "5. " +
      I18n.t(
        "若用户指定了关注点，优先围绕它给方案；但发现更要紧的问题也要占一条，并在 desc 里说明理由。",
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
      "完成后更新画布上该开发节点的概述（note）与状态（devStatus），并用一句话汇报改了什么。",
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

/* ---------- 建议对话框（进度 → 就地变成方案清单） ---------- */
function devSuggestDialog(node, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const box = devDlgOpen(host, "mt-sug-box");
    const titleEl = host.querySelector("#mtDlgTitle");
    const bodyEl = host.querySelector("#mtDlgBody");
    const st = {
      phase: "run",
      focus: String(opts.focus || ""),
      suggestion: null,
      picked: {},
      err: "",
      running: false,
      settled: false,
      lines: [],
      toolCount: 0,
      startedAt: 0,
      elapsed: "0s",
    };
    let ta = null;
    let logEl = null;
    let tick = null;
    const alive = () => !st.settled && seq === _mtDialogSeq;
    const finish = (val) => {
      if (st.settled) return;
      st.settled = true;
      if (tick) clearInterval(tick);
      tick = null;
      host.removeEventListener("keydown", onKey);
      devDlgClose(host, box, "mt-sug-box");
      resolve(val || null);
    };
    const stampElapsed = () => {
      const el = host.querySelector("#mtSugElapsed");
      if (el)
        el.textContent =
          st.elapsed + " · " + st.toolCount + I18n.t(" 次只读工具调用");
    };
    const logLine = (txt) => {
      const t = String(txt || "").replace(/\s+/g, " ").trim();
      if (!t || !alive() || st.phase !== "run") return;
      if (st.lines[st.lines.length - 1] === t) return;
      st.lines.push(t);
      while (st.lines.length > 200) st.lines.shift();
      if (logEl) {
        logEl.appendChild(devDlgEl("div", "mt-sug-log-row", t));
        while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
    };
    /* ---- 跑一轮建议（只读） ---- */
    const runOnce = () => {
      if (!alive() || st.running) return;
      const sup = typeof dshSupported === "function" ? dshSupported() : { ok: false };
      st.phase = "run";
      st.lines = [];
      st.err = "";
      st.toolCount = 0;
      st.startedAt = Date.now();
      st.elapsed = "0s";
      /* 先置 running 再渲染：进度态的按钮要直接是「停止生成」 */
      st.running = true;
      render();
      if (!sup.ok) {
        st.running = false;
        st.err = sup.reason || I18n.t("智能能力不可用");
        st.phase = "failed";
        render();
        return;
      }
      logLine(
        I18n.t("开始只读调研（不改文件、不改画布）· 项目根：") +
          (devPathOf(node) || I18n.t("（未设置 · 用默认工作区）")),
      );
      if (tick) clearInterval(tick);
      tick = setInterval(() => {
        if (!alive()) return;
        const sec = Math.round((Date.now() - st.startedAt) / 1000);
        st.elapsed = sec >= 60 ? Math.floor(sec / 60) + "m" + sec % 60 + "s" : sec + "s";
        stampElapsed();
      }, 1000);
      st.running = true;
      dshRunTask(devSuggestPrompt(node, st.focus), {
        workspace: devPathOf(node) || "",
        runKey: devSuggestRunKey(node),
        preset: "standard",
        effort: "high",
        systemPrompt: devSuggestSystemPrompt(),
        onEvent: (type, data) => {
          if (!alive()) return;
          if (type === "tool" && data && data.name) {
            st.toolCount++;
            let arg = "";
            const rawArgs = data.args;
            if (typeof rawArgs === "string") {
              const hit = rawArgs.match(
                /"(?:file_path|path|pattern|query|command|include)"\s*:\s*"([^"]{1,160})"/i,
              );
              arg = hit ? hit[1] : rawArgs.slice(0, 120);
            } else if (rawArgs && typeof rawArgs === "object") {
              arg = String(
                rawArgs.file_path ||
                  rawArgs.path ||
                  rawArgs.pattern ||
                  rawArgs.query ||
                  rawArgs.include ||
                  rawArgs.command ||
                  "",
              ).slice(0, 120);
            }
            logLine("🔧 " + data.name + (arg ? "  " + arg : ""));
            stampElapsed();
          } else if (type === "error" && data && data.message) {
            logLine("⚠ " + data.message);
          }
        },
      })
        .then((text) => {
          if (!alive()) return;
          st.running = false;
          if (tick) clearInterval(tick);
          const sug = devSuggestParse(text);
          if (!sug) {
            st.phase = "failed";
            st.err = I18n.t(
              "模型没有按契约返回方案。可以再试一次，或关掉本框改用「开发」按钮自己填写内容。",
            );
            render();
            return;
          }
          st.suggestion = sug;
          st.picked = {};
          st.picked[sug.items[0].id] = true;
          node.devSuggest = {
            at: sug.at,
            summary: sug.summary,
            basis: sug.basis,
            items: sug.items,
          };
          scheduleSave(true);
          try {
            renderCanvas();
          } catch (_) {}
          st.phase = "options";
          render();
        })
        .catch((err) => {
          if (!alive()) return;
          st.running = false;
          if (tick) clearInterval(tick);
          const msg = (err && err.message) || String(err);
          if (typeof isCancelishError === "function" && isCancelishError(msg)) {
            finish(null);
            return;
          }
          st.phase = "failed";
          st.err = msg;
          render();
        });
    };
    const abortRun = () => {
      if (!st.running) return;
      st.running = false;
      try {
        dshCancelActive(devSuggestRunKey(node));
      } catch (_) {}
    };
    const goDevelop = (ids, supplement) => {
      if (!st.suggestion) return;
      if (!ids.length && !supplement) {
        st.err = I18n.t("至少勾选一个方案，或在「补充说明」里写下你要做什么。");
        render();
        return;
      }
      const brief = devSuggestBriefText(node, st.suggestion, ids, supplement);
      node.devSuggest = Object.assign({}, node.devSuggest || {}, {
        picked: ids,
        supplement,
      });
      scheduleSave(true);
      finish({ action: "dev", text: brief, picked: ids, supplement });
      startDevSessionWithText(node, brief);
    };
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        abortRun();
        finish(null);
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        if (st.phase === "options") {
          const extra = ta ? String(ta.value || "").trim() : "";
          goDevelop(
            st.suggestion.items.filter((it) => st.picked[it.id]).map((it) => it.id),
            extra,
          );
        } else if (st.phase === "failed") runOnce();
      } else if (
        st.phase === "options" &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        /^[1-9]$/.test(ev.key)
      ) {
        const ae = document.activeElement;
        if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return;
        const it = st.suggestion.items[Number(ev.key) - 1];
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
          (st.phase === "run"
            ? I18n.t("生成建议")
            : st.phase === "failed"
              ? I18n.t("建议生成失败")
              : I18n.t("建议")) +
          " · " +
          (node.title || I18n.t("开发节点"));
      if (bodyEl) bodyEl.innerHTML = "";
      const footEl = host.querySelector("#mtDlgFoot");
      if (footEl) footEl.innerHTML = "";
      ta = null;
      logEl = null;
      if (st.phase !== "options") {
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
        if (st.focus) addRow(I18n.t("本轮关注点"), clipStr(st.focus, 90));
        if (st.phase === "run") {
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
        if (st.phase === "run") {
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
          for (const l of st.lines) logEl.appendChild(devDlgEl("div", "mt-sug-log-row", l));
          bodyEl.appendChild(logEl);
        } else {
          bodyEl.appendChild(devDlgEl("p", "mt-form-warn", st.err));
        }
        if (footEl) {
          footEl.appendChild(
            devDlgBtn({
              label: st.running ? I18n.t("停止生成") : I18n.t("关闭"),
              run: () => {
                abortRun();
                finish(null);
              },
            }),
          );
          if (st.phase === "failed")
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
          suggestion: st.suggestion,
          picked: st.picked,
          err: st.err,
          supplement: String(st.focus || ""),
          onCancel: () => finish(null),
          onRegen: runOnce,
          onDev: goDevelop,
          onPick: () => {
            st.err = "";
          },
        });
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
    runOnce();
  });
}

/* ---------- 上次建议（不重跑模型） ---------- */
function devSuggestCachedDialog(node, sug, focus) {
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const box = devDlgOpen(host, "mt-sug-box");
    const titleEl = host.querySelector("#mtDlgTitle");
    const st = { picked: {}, err: "", settled: false };
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
        supplement: String((sug && sug.supplement) || focus || ""),
        hint: I18n.t(
          "这是上一次生成的方案（未重新调用模型）。想听新的评估：点「换一批」重新让 AI 判断，或取消后在确认框里选「确认生成建议」。数字键勾选 · Ctrl+Enter 开发 · Esc 取消",
        ),
        onCancel: () => finish(null),
        onRegen: () => finish({ action: "regen" }),
        onDev: go,
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
  const rows = [
    [I18n.t("元素类型"), I18n.t(DEV_KIND_LABEL[dk] || "模块")],
    [I18n.t("开发状态"), devStatusText(devStatusOf(node))],
    [I18n.t("项目根目录"), p || I18n.t("（未设置）")],
    [
      I18n.t("下层元素"),
      kids.length ? kids.length + I18n.t(" 个") : I18n.t("（无）"),
    ],
    [I18n.t("历史会话"), devSessionsOf(node).length + I18n.t(" 个")],
  ];
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
  actions.push({ id: "go", label: I18n.t("确认生成建议"), primary: true });
  const res = await mtDialogForm({
    title: I18n.t("建议") + " · " + (node.title || I18n.t("开发节点")),
    wide: true,
    rows,
    note: { label: I18n.t("模块概述"), text: node.note },
    msg: I18n.t(
      "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），再给出 4 条「下一步实现什么」的方案。你可以在同一个对话框里多选、补充，然后点该对话框里的「开发」直接开工。",
    ),
    warn: p
      ? ""
      : I18n.t(
          "尚未设置项目根目录（devPath）：AI 只能在默认工作区里找代码，建议先在顶层功能块上设置项目路径。",
        ),
    textarea: {
      label: I18n.t("本轮关注点（可选 · 留空由 AI 自行判断）"),
      placeholder: I18n.t(
        "例如：这轮只看健壮性和测试；优先把与「网络层」的接线补上；不要引入新依赖…",
      ),
      rows: 4,
    },
    hint: I18n.t(
      "确认 = 只读评估（工作区 = 项目根目录）· 生成后可多选 / 换一批 · Ctrl+Enter 确认 · Esc 取消",
    ),
    actions,
  });
  if (!res) return;
  const focus = String(res.text || "").trim();
  if (res.action === "cached") {
    const out = await devSuggestCachedDialog(node, cached, focus);
    if (out && out.action === "regen") await devSuggestDialog(node, { focus });
    return;
  }
  if (res.action === "go") await devSuggestDialog(node, { focus });
}
