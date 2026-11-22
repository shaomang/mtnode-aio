"use strict";
/* ============================================================
 * renderer/app-brief.js — 会话简报内核（纯函数 · 进程无关）
 *
 * 简报 = 这次会话跑到哪儿了的一页结论。做法是增量的：隔几步把「上一版简报 +
 * 新增步骤的中性事实」交给模型，让它重写整份新版；本文件不存状态、不调模型。
 * 三件事，只此三件（与 app-assist-state.js 同风格，不碰 DOM、不碰 window.api、
 * 不读盘 —— 纯 Node 可直接 require，好在冒烟里钉死口径）：
 *   ① promptOf({userAsk, prevBrief, steps}) 组装增量提示词；
 *   ② parse(text, steps) 把模型输出规整成
 *      { state, points:[{text, refs, stepIds, status}], outputs:[], blockers:[], stale }；
 *   ③ labelOf / argOf 词表，sig 节流签名。
 *
 * 口径（改动前先读，逐条钉在 test/smoke-session-brief.js）：
 *   · 简报是**结论式陈述**，不是过程旁白：每条要点必须是「做了什么 → 得到 / 确认了
 *     什么」的完整陈述。进行时（正在 / 正打算）与预告（接下来 / 准备 / 即将）一律不收：
 *     提示词里明写，解析处再兜一刀（narrationOf）。没拿到结论的步骤不许占行。
 *   · 结构四段：state（一句话现状）· points（发现与结论）· outputs（产出 / 改动）·
 *     blockers（卡点 / 待定）。旧存档 { summary, items } 照样读得懂（prevBrief 与
 *     parse 双向兼容），parse 另留 summary / items 两份等值镜像给老读者。
 *   · **不写文件名、不贴参数**：步骤事实先过 sanitize —— 路径、扩展名、命令行开关、
 *     键值、引号 / 反引号里的原文一律抹掉；中文主题词（「简报内核」「冒烟脚本」）留着，
 *     否则模型手里无料可写。工具只留中文标签 + 「作用于什么」的名词（labelOf / argOf）。
 *     工具原始参数（args / command / path…）**根本不读**。
 *   · 事实要够厚（任务 3/8）：一步给「动作 + 对象主题 + 结果摘要（多条关键行）+
 *     思考正文摘要 + 这一轮写出来的正文片段」，不再只有「工具名 + 结果首行」——
 *     首行往往是噪声，只给它就只剩「正在读取…」可写。调度器那侧只挑**已办完、有结果**
 *     的步喂进来（进行中的步不成事实，模型就没有被迫写进行时的机会）。
 *   · 模型漏步、多步都不许崩，也不许替它编：对不上的条目 stepIds 留空，整份标 stale，
 *     由上层决定是否重算。条目数只等于模型真写出来的条数。
 *   · 状态只有三种：done / running / error。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.MTBrief = api;
})(typeof window !== "undefined" ? window : null, function () {
  const STEP_CAP = 60; /* 提示词里最多带这么多步（再多只带尾部：简报看的是「到哪了」） */
  const FACT_CAP = 56; /* 薄事实（结果首行）的字符上限 */
  /* ── 事实厚度（任务 3/8：一步不再只给「工具名 + 结果首行」）────────────────
     取值理由：
     · RESULT_CAP = 300：结果摘要要够模型写出一条结论 —— 一条工具结果往往前几行是
       噪声（目录清单 / 空行），关键行在第 2–4 行，串起来大约就是这个量级；
     · THINK_CAP = 400：思考是佐料，比结果长一点即可，再长只会挤掉别的步；
     · DRAFT_CAP = 800：这一轮已经写出来的正文片段是**模型自己的白话**，比任何中性
       标签都更接近结论，给它最宽的一档；
     · 三者都逐行清理后**串成一行**（见 sanitizeLines），一步仍然只占一条事实。 */
  const RESULT_CAP = 300;
  const THINK_CAP = 400;
  const DRAFT_CAP = 800;
  const FACT_LINES = 4; /* 结果 / 思考各最多取几条关键行 */
  const DRAFT_LINES = 6; /* 正文片段最多取几段 */
  /* 事实区总预算：从最新一步往回分（新的料更值钱），超预算的老步骤退化成薄事实
     （动作 + 对象 + 状态 + 结果首行）—— 一轮几十步时提示词长度仍然封顶。 */
  const FACT_BUDGET = 12000;
  const THIN_CAP = 56;
  const ASK_CAP = 200; /* 用户原话上限 */
  const PREV_CAP = 1600; /* 上一版简报上限 */
  const POINT_CAP = 240; /* 单条要点的字符上限 */

  const DONE = "done";
  const RUNNING = "running";
  const ERROR = "error";

  /* ── 工具词表：[判据, 中文标签, 作用于什么的名词] ───────────────────────
     只收常见族，判据按名字前缀 / 全名匹配；认不出来走兜底「动手 / 内容」，
     不猜、也不把原始工具名摆进简报。 */
  const TOOL_WORDS = [
    /* 思考段：调度器（app-brief-sched.js）把每段思考也当一步喂进来（name = "think"），
       它没有工具名，靠这一行才不会退成兜底的「动手」。 */
    [/^(think|reasoning|thought)$/i, "思考", "思路"],
    /* 出错段（调度器把 err 段当一步喂进来，name = "err"）：别退成兜底的「动手」，
       一步出错就该说成「报错」。 */
    [/^(err|error|fail|failed)$/i, "报错", "这一次的运行"],
    [/^(read|view|read_file)$/i, "读取", "文件"],
    [/^(write|create|create_file)$/i, "新建", "文件"],
    [/^(edit|str_replace.*|apply_patch)$/i, "修改", "文件"],
    [/^(ls|list|glob)$/i, "列目录", "目录"],
    [/^(grep|search|rg)$/i, "搜索", "关键词"],
    [/^(pwsh|bash|sh|shell|exec|run_command)$/i, "运行命令", "命令"],
    [/^(web_search|web_fetch|fetch|browse)$/i, "查资料", "网页"],
    [/^(subagent|subagent_fork|agent|task)$/i, "派子任务", "子任务"],
    [/^job_/i, "管后台任务", "后台任务"],
    [/^(todo_write|plan|plan_.*)$/i, "更新计划", "计划"],
    [/^(ask_user_question|ask|ask_user)$/i, "问你一句", "问题"],
    [/canvas/i, "改画布", "画布"],
    [/^(mtnode_)?facts$/i, "查事实库", "项目事实"],
    [/^mtnode_(vision|screenshot)$/i, "看图", "画面"],
    [/^(mtnode_)?manifest$/i, "对资产账", "资产"],
    [/^mtnode_(tool|app|db|dev)_/i, "调应用能力", "应用"],
    [/^(create_goal|get_goal|update_goal)$/i, "看目标", "目标"],
    [/^list_agents$/i, "看子智能体", "子任务"],
    [/^send_message$/i, "交代一句", "子任务"],
  ];

  /* ── 文本清理：去路径 / 文件名 / 开关 / 键值 / 引号原文，留中文主题词 ───── */

  const EXT_RE =
    /\b[\w.-]*\.(?:js|mjs|cjs|jsx|tsx|ts|json|jsonc|mdx|md|css|scss|less|html?|png|jpe?g|gif|svg|webp|ico|mp4|mov|wav|mp3|flac|txt|log|py|ps1|bat|cmd|sh|ya?ml|toml|ini|csv|db|exe)\b/gi;

  const CJK_RE = /[\u4e00-\u9fa5]/;

  /* 单行清理（sanitize / sanitizeLines 共用）：路径、扩展名、命令行开关、键值、
     引号 / 反引号里的原文一律抹掉。 */
  function scrubLine(v) {
    const raw = String(v == null ? "" : v).replace(/\r\n?/g, "\n").split("\n")[0];
    let s = raw;
    s = s.replace(/```[\s\S]*$/, " ");
    s = s.replace(/`[^`]*`/g, " ");
    s = s.replace(/"[^"]*"/g, " ");
    s = s.replace(/'[^']*'/g, " ");
    /* 路径：分隔符后面必须跟 ASCII 本体才算路径 —— 「读取/写入」这种中文并列不当路径，
       中文主题词（简报内核 / 冒烟脚本 / 画布）不能被顺手抹光，否则模型无料可写。 */
    s = s.replace(/(?:[A-Za-z]:)?[\\/][A-Za-z0-9_@%.\-~\\/]*/g, " ");
    s = s.replace(/[A-Za-z0-9_.\-~]+(?:[\\/][A-Za-z0-9_.\-~]*)+/g, " ");
    s = s.replace(/\b[\w.-]+=[^\s，。；]+/g, " "); /* 键=值 */
    s = s.replace(/(?:^|\s)--?[\w-]+(?:=\S*)?/g, " "); /* 命令行开关（连它的值一起） */
    s = s.replace(EXT_RE, " "); /* 光秃秃的文件名 */
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/^[·\-:：，。；、\s]+/, "").replace(/[，、；:\s]+$/, "");
    /* 抹完之后只剩渣、而原句里本来有中文：退到中文主题词（这是模型唯一还能用的料）。 */
    if (s.length < 2 && CJK_RE.test(raw)) {
      s = raw.replace(/[^\u4e00-\u9fa5]+/g, " ").replace(/\s+/g, " ").trim();
    }
    return s;
  }

  function clip(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n).trim() + "…" : t;
  }

  function sanitize(v, cap) {
    return clip(scrubLine(v), cap || FACT_CAP);
  }

  /* 多行清理（任务 3/8 的事实加厚）：结果 / 思考 / 正文片段本来就是多行的，
     只取第一条会把最有用的结论丢掉。逐行清理后用「；」串成**一行**（排版仍是
     「一步一条事实」），最多 maxLines 条 / cap 字，截断了补一个「…」。 */
  function sanitizeLines(v, cap, maxLines) {
    const maxLinesN = maxLines || FACT_LINES;
    const raw = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
    const lines = raw.split("\n").map(scrubLine).filter(Boolean);
    const parts = [];
    let used = 0;
    for (const one of lines) {
      if (parts.length >= maxLinesN) return parts.join("；") + "…";
      if (used + one.length > cap) {
        const room = cap - used - 1;
        if (room > 0) parts.push(one.slice(0, room).replace(/[，、；:\s]+$/, ""));
        return parts.join("；") + "…";
      }
      parts.push(one);
      used += one.length + 1;
    }
    return parts.join("；");
  }

  /* 简报正文：不做路径抹除（模型写出来的白话），只压空白、拉平箭头与长度。 */
  function cleanText(v, cap) {
    let s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    s = s.replace(/^[·\-:：，。；、\s]+/, "");
    s = s.replace(/\s*(?:-->|->|=>|→)\s*/g, " → ");
    const n = cap || POINT_CAP;
    return s.length > n ? s.slice(0, n).trim() + "…" : s;
  }

  /* ── 状态归一 ─────────────────────────────────────────────────────── */

  function statusOf(v) {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    if (/^(error|err|fail|failed|失败|出错|错误|报错)$/.test(s)) return ERROR;
    if (/^(running|run|pending|doing|busy|proceed|进行中|运行中|在做|还没完)$/.test(s)) return RUNNING;
    return DONE;
  }

  /* ── 步骤归一：只吃中性事实（工具名 / 结果摘要 / 状态 / 思考摘要 / 正文片段）──
     原始参数（args / command / path / params…）**故意不读** —— 读了就会把文件名与
     命令行带进提示词，正是简报不能有的东西。 */
  function normStep(s, i) {
    const o = s && typeof s === "object" ? s : {};
    return {
      id: String(o.id || o.stepId || o.key || o.seq || i + 1).trim() || String(i + 1),
      name: String(o.tool || o.name || o.title || "").trim(),
      status: statusOf(o.status || o.state),
      /* 结果 / 思考都是一整段（多行）：走 sanitizeLines 取前几条关键行，串成一行 */
      result: sanitizeLines(o.result || o.output || o.text || o.detail || "", RESULT_CAP, FACT_LINES),
      think: sanitizeLines(o.think || o.reasoning || o.thought || "", THINK_CAP, FACT_LINES),
      /* 这一轮已经写出来的正文片段（调度器挂在最新那一步上；别的步没有） */
      draft: sanitizeLines(o.draft || o.wrote || "", DRAFT_CAP, DRAFT_LINES),
    };
  }

  function stepList(steps) {
    const arr = Array.isArray(steps) ? steps : [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const st = normStep(arr[i], i);
      let id = st.id;
      let n = 1;
      while (out.some((x) => x.id === id)) id = st.id + "-" + n++; /* 撞 id 就加后缀，不丢步 */
      st.id = id;
      out.push(st);
    }
    return out;
  }

  /* ── 词表出口 ─────────────────────────────────────────────────────── */

  /* 工具名 → 中文标签。给了回调（界面的 dshToolTitleOf 之类）先用它，取回空串再退内置词表。 */
  function labelOf(name, titleOf) {
    const nm = String(name == null ? "" : name).trim();
    if (!nm) return "动手";
    if (typeof titleOf === "function") {
      try {
        const t = titleOf({ name: nm });
        const s = String(t == null ? "" : t).trim();
        if (s) return s;
      } catch (_) {
        /* 回调炸了不影响简报：退内置词表 */
      }
    }
    for (const row of TOOL_WORDS) if (row[0].test(nm)) return row[1];
    return "动手";
  }

  /* 工具名 → 它作用于什么（写「读取了文件」而不是「读取了 xxx.js」）。 */
  function argOf(name) {
    const nm = String(name == null ? "" : name).trim();
    if (!nm) return "内容";
    for (const row of TOOL_WORDS) if (row[0].test(nm)) return row[2];
    return "内容";
  }

  /* ── 节流签名：同一批步骤恒定，加一步 / 改状态就变 ──────────────────── */
  function sig(steps) {
    const list = stepList(steps);
    if (!list.length) return "0";
    let h = 2166136261;
    for (const s of list) {
      const k = s.id + "\u0001" + s.status + "\u0001" + s.result + "\u0001" + s.think + "\u0001" + s.draft + "\u0001" + s.name;
      for (let i = 0; i < k.length; i++) {
        h ^= k.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    }
    return list.length + ":" + (h >>> 0).toString(36);
  }

  /* ── 上一版简报：字符串直接用；结构新旧两版都认 ──────────────────────
     新：{ state, points[], outputs[], blockers[] }；旧存档：{ summary, items[] }。 */
  function prevText(prev) {
    if (!prev) return "";
    if (typeof prev === "string") return cleanText(prev, PREV_CAP);
    if (typeof prev !== "object") return "";
    const parts = [];
    const state = String(prev.state || prev.summary || "").trim();
    if (state) parts.push("现状：" + cleanText(state, PREV_CAP));
    const pts = Array.isArray(prev.points) ? prev.points : Array.isArray(prev.items) ? prev.items : [];
    for (const it of pts) {
      const t = it && typeof it === "object" ? it.text : it;
      if (t) parts.push("- " + cleanText(t, 160));
    }
    const outs = Array.isArray(prev.outputs) ? prev.outputs : [];
    for (const it of outs) {
      const t = it && typeof it === "object" ? it.text : it;
      if (t) parts.push("产出：" + cleanText(t, 160));
    }
    const blk = Array.isArray(prev.blockers) ? prev.blockers : [];
    for (const it of blk) {
      const t = it && typeof it === "object" ? it.text : it;
      if (t) parts.push("卡点：" + cleanText(t, 160));
    }
    return parts.join("\n").slice(0, PREV_CAP);
  }

  const STATUS_ZH = {};
  STATUS_ZH[DONE] = "完成";
  STATUS_ZH[RUNNING] = "进行中";
  STATUS_ZH[ERROR] = "出错";

  /* 一步 → 提示词里的几条中性事实（任务 3/8 加厚）。
     首行恒定是「- [步号] 动作 · 对象 · 状态」，其余行缩进两格跟着它：
     · 步子多 / 太长时老步骤退化成**薄事实**（rich=false）：只剩首行 + 结果首行，
       提示词长度封顶；
     · 出错带【出错】醒目标记。 */
  function factLines(st, rich) {
    const bits = [];
    bits.push(labelOf(st.name));
    bits.push("对象：" + argOf(st.name));
    bits.push("状态：" + (st.status === ERROR ? "【出错】" : STATUS_ZH[st.status] || "完成"));
    const out = ["- [" + st.id + "] " + bits.join(" · ")];
    if (!rich) {
      if (st.result) out.push("  结果：" + clip(st.result, THIN_CAP));
      return out;
    }
    if (st.result) out.push("  结果：" + st.result);
    if (st.think) out.push("  当时想：" + st.think);
    if (st.draft) out.push("  这一轮写出来的正文片段：" + st.draft);
    return out;
  }

  /* 哪些步给厚事实：从最新一步往回分预算（新的料更值钱），一分不够就从那里开始
     一律退化成薄事实 —— 越老的细节越不值钱，宁可只留动作与结果首行。
     最新那一步无条件给厚的（哪怕它自己就超预算）：否则整份事实一行结论都不剩。 */
  function richMask(list) {
    const mask = [];
    let budget = FACT_BUDGET;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      const cost = st.result.length + st.think.length + st.draft.length + 8;
      if (cost > budget && i < list.length - 1) break;
      budget -= cost;
      mask[i] = true;
    }
    return mask;
  }

  /* ── ① 增量提示词（结论式陈述：正例 + 反例 + 硬禁止） ──────────────── */
  function promptOf(o) {
    const src = o && typeof o === "object" ? o : {};
    let ask = sanitize(src.userAsk, ASK_CAP);
    let prev = prevText(src.prevBrief);
    let list = stepList(src.steps);
    if (list.length > STEP_CAP) {
      list = list.slice(list.length - STEP_CAP);
      prev = (prev ? prev + "\n" : "") + "（更早的步骤略）";
    }
    const lines = [];
    lines.push("你在写这次会话的「简报」：给用户看的一页结论 —— 做到了哪儿、拿到了什么。");
    lines.push("");
    lines.push("每一行都必须是「做了什么 → 得到 / 确认了什么」的完整陈述：用户只读这一行就该知道结论，");
    lines.push("不必回看过程。");
    lines.push("");
    lines.push("正例（照这个力度写）：");
    lines.push("- 重写了简报的产出结构，把进行时旁白换成结论式陈述 @3");
    lines.push("- 读了冒烟里的旧断言，确认旧存档必须继续认 @5");
    lines.push("");
    lines.push("反例（这么写一律不算）：");
    lines.push("- 正在读取相关实现 @2");
    lines.push("- 搜索代码位置 @4");
    lines.push("- 准备改简报内核");
    lines.push("（反例的病：只写动作不写结果、用进行时、预告下一步。）");
    lines.push("");
    lines.push("规矩（照做，不要解释你怎么写）：");
    lines.push("· 只写已经发生、已经有结果的事；没拿到结论的步骤不许占行 —— 宁可不写，不要凑；");
    lines.push("· 要点 2–6 条：不许拉成流水账，也不许只丢一句糊过去；");
    lines.push("· 不许进行时（正在 / 正打算），不许写「接下来 / 下一步 / 准备 / 即将」这类预告；");
    lines.push("· 不许只写动作：「做了什么」后面必须跟「因此知道 / 因此改了 / 因此确认了什么」；");
    lines.push("· 事实里给了结果摘要、思考摘要与这一轮写出的正文片段：结论要落在「拿到了什么」上，别只复述动作；");
    lines.push("· 不许编：事实里没有的不写，没把握的不写；");
    lines.push("· 不写文件名、不写路径、不贴命令 / 参数 / 代码 / 日志原文；要指代就说主题词（如「简报内核」「冒烟脚本」「画布」）；");
    lines.push("· 白话、简约，不用「我们」，不客套，不加表情、不加序号套话。");
    lines.push("");
    lines.push("输出格式（只输出这几段，别的都不要）：");
    lines.push("现状：<一句话：在做什么、到哪了>");
    lines.push("- <做了什么 → 得到 / 确认了什么> @<步号>");
    lines.push("产出：");
    lines.push("- <这次留下的产出 / 改动>");
    lines.push("卡点：");
    lines.push("- <卡住或还没定的>");
    lines.push("（要点 2–6 条；产出 / 卡点没有就写「无」；对不上步的要点不写 @。）");
    lines.push("");
    lines.push("用户这一轮想要的：" + (ask || "（没写，按下面的事实推）"));
    lines.push("");
    lines.push("上一版简报（没有就写「无」，有就顺着它改成新版，不要推翻重写）：");
    lines.push(prev || "无");
    lines.push("");
    lines.push("本轮的事实（中性，不评价，别加戏）：");
    if (!list.length) {
      lines.push("（暂时还没有可写的步骤：现状写「刚起步」，不要编条目。）");
    } else {
      /* 每步首行 = `- [步号] 动作 · 对象 · 状态`，随后缩进几行给它自己的料
         （结果摘要 / 思考摘要 / 这一轮写出的正文片段）；超预算的老步骤只有薄事实。 */
      const mask = richMask(list);
      for (let i = 0; i < list.length; i++) {
        for (const ln of factLines(list[i], mask[i] === true)) lines.push(ln);
      }
    }
    lines.push("");
    lines.push(
      "现在重写整份新版：现状一行 + 2–6 条结论要点（没结论的步骤不许占行）+ 产出 + 卡点。不编、不写进行时、不预告下一步。"
    );
    return lines.join("\n");
  }

  /* ── ② 解析模型输出 ───────────────────────────────────────────────── */

  const REF_RE = /(?:@|＃|#)\s*([0-9A-Za-z_.:-]+(?:[\s,，、/]+[0-9A-Za-z_.:-]+)*)\s*$/;
  const ST_RE = /[（(【\[]\s*(出错|失败|错误|报错|进行中|运行中|完成|已办|error|fail|failed|running|done)\s*[)）】\]]\s*$/i;

  /* 段头：现状 / 产出 / 卡点。旧存档的「总述：」「摘要：」一律当现状。 */
  const HEAD_STATE = /^(现状|总述|摘要|一句话|小结|状态)\s*[:：]\s*/;
  const HEAD_OUT = /^(产出|输出|改动|交付)\s*(?:[:：]\s*|$)/;
  const HEAD_BLOCK = /^(卡点|待定|阻塞|遗留|风险)\s*(?:[:：]\s*|$)/;

  /* 动作旁白 / 进行时 / 预告：这种行不是结论，一条都不收（提示词里已明禁，这里兜底）。 */
  function narrationOf(s) {
    const t = String(s || "");
    if (!t) return false;
    if (/正在|正打算/.test(t)) return true;
    if (/^(?:准备|打算|接下来|下一步|即将|将要|待会儿|待会|稍后)/.test(t)) return true;
    return false;
  }

  function refsOf(raw) {
    const out = [];
    for (let r of String(raw || "").split(/[\s,，、/]+/)) {
      r = r.trim();
      if (!r) continue;
      if (/^s\d+$/i.test(r)) r = r.slice(1);
      if (out.indexOf(r) < 0) out.push(r);
    }
    return out;
  }

  function itemOf(body, byId) {
    let s = String(body || "").trim();
    if (!s) return null;
    let refs = [];
    const m = REF_RE.exec(s);
    if (m) {
      refs = refsOf(m[1]);
      s = s.slice(0, m.index).trim();
    }
    let status = "";
    const st = ST_RE.exec(s);
    if (st) {
      status = statusOf(st[1]);
      s = s.slice(0, st.index).trim();
    }
    const text = cleanText(s);
    if (!text) return null;
    if (narrationOf(text)) return null; /* 过程旁白：不成条目 */
    const stepIds = [];
    for (const id of refs) if (byId[id] && stepIds.indexOf(id) < 0) stepIds.push(id);
    if (!status) {
      status = DONE;
      for (const id of stepIds) if (byId[id].status === ERROR) status = ERROR;
      if (status !== ERROR) {
        for (const id of stepIds) if (byId[id].status === RUNNING) status = RUNNING;
      }
    }
    return { text: text, refs: stepIds, stepIds: stepIds, status: status };
  }

  function parse(text, steps) {
    const list = stepList(steps);
    const byId = {};
    for (const st of list) byId[st.id] = st;
    const out = { state: "", points: [], outputs: [], blockers: [], stale: false };
    let section = ""; /* "" = 要点区 · "out" = 产出 · "blk" = 卡点 */
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    for (const raw of lines) {
      let line = String(raw || "").trim();
      if (!line) continue;
      if (/^```/.test(line)) continue;
      const hs = HEAD_STATE.exec(line);
      if (hs) {
        const t = cleanText(line.slice(hs[0].length));
        if (!out.state && t) out.state = t;
        section = "";
        continue;
      }
      const ho = HEAD_OUT.exec(line);
      if (ho) {
        const t = cleanText(line.slice(ho[0].length));
        section = "out";
        if (t && t !== "无") out.outputs.push(t);
        continue;
      }
      const hb = HEAD_BLOCK.exec(line);
      if (hb) {
        const t = cleanText(line.slice(hb[0].length));
        section = "blk";
        if (t && t !== "无") out.blockers.push(t);
        continue;
      }
      const bullet = line.replace(/^(?:[-*•·]|\[[ xX]\]|\d+[.、)]|[（(]\d+[)）])\s*/, "");
      if (bullet !== line) {
        if (section === "out" || section === "blk") {
          const t = cleanText(bullet);
          if (t && t !== "无") (section === "out" ? out.outputs : out.blockers).push(t);
          continue;
        }
        const it = itemOf(bullet, byId);
        if (it) out.points.push(it);
        continue;
      }
      if (!out.state && !out.points.length) {
        const t = cleanText(line);
        if (t) out.state = t;
      }
    }
    /* stale：这版简报跟当前轨迹对不上（有步没人写 / 有行对不上步）—— 上层可据此重算。
       只做判断，绝不替模型补行。 */
    if (list.length) {
      const covered = {};
      let dangling = false;
      for (const it of out.points) {
        if (!it.stepIds.length) dangling = true;
        for (const id of it.stepIds) covered[id] = true;
      }
      let missing = false;
      for (const st of list) if (!covered[st.id]) missing = true;
      out.stale = !!(dangling || missing);
    }
    /* 旧读者（调度器 / 卡片层）按 summary + items 取值：留两份等值镜像，不改形状。 */
    out.summary = out.state;
    out.items = out.points;
    return out;
  }

  return {
    STEP_CAP: STEP_CAP,
    /* 事实厚度（任务 3/8）：结果摘要 / 思考摘要 / 正文片段 / 事实区总预算 */
    RESULT_CAP: RESULT_CAP,
    THINK_CAP: THINK_CAP,
    DRAFT_CAP: DRAFT_CAP,
    FACT_LINES: FACT_LINES,
    FACT_BUDGET: FACT_BUDGET,
    STATUS: { DONE: DONE, RUNNING: RUNNING, ERROR: ERROR },
    promptOf: promptOf,
    parse: parse,
    labelOf: labelOf,
    argOf: argOf,
    sig: sig,
    sanitize: sanitize,
    sanitizeLines: sanitizeLines,
    statusOf: statusOf,
  };
});
