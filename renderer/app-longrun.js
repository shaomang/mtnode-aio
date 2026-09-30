/* ============================================================================
   app-longrun.js — 会话的长时自治：自动续跑 + 累计状态 + 分阶段自检的落点

   用户已确认的口径（本功能块的开发任务书与拷问共识）：
     · 长时能力＝「会话内自动续跑」+「跨重启的活改走长周期任务图」两条腿：
       会话跑完一轮，若目标仍未达成且还有下一步 → 自动接着跑下一轮，不必用户点；
       会话自己判断这活跨重启（要数小时、要断点续跑）就**建议**提升为长周期任务图，
       但绝不自动替用户改图（等用户点确认）。
     · **不自动中断、不弹卡**（用户明确选了「我自己盯」）：时间 / 轮数 / 开销只做
       累计小字显示，不拦人。安全上限仍保留（防止失控空转烧钱），命中即停并告知 ——
       这是唯一的自动停止，属「防跑飞」而非「到点问人」。
     · 停止条件（以目标达成为准，自检判停）：
       ① 最后一条答复给出完成信号（全部完成 / 已交付 / 阻塞求助……）；
       ② 会话清单里的待办全部收口（没有 pending / in_progress / 未确认）；
       ③ 用户按了终止或暂停；
       ④ 命中安全上限（默认 30 轮）—— 停并提示可手动继续。
     · 清单未收口 → 补一轮「同步清单」（本轮修复）：轮末 agentFinalizeTodos 会把没跑完的
       条目标成「未确认（?）」，模型要是没在那轮里再写一次 todo_write，清单就永远挂着问号。
       此时不判停，自动补一轮只让它把 todo_write 的每条状态写对（最多 TODO_SYNC_MAX 轮，
       到顶停下并说明原因）—— 治「会话里任务已完成、清单列表却全是 ?」。
     · **收工信号判停（本轮修复 · 用户报「AI 已明确说完成，自动续跑仍追轮，最后把冒烟测试
       重跑了一遍」）**：老口径下三条路都会放行一次没用的追轮 ——
         ① DONE_RE 词表太窄（只认「全部完成 / 已交付」那一小撮），模型写在正文里的
            「改完了」「已修复」「跑绿了」「修好了」一个都认不出；
         ② 判停②排在「清单未收口」之后：本轮只要还剩一条「?」，收工信号压根不参与判停；
         ③ 两种自动指令（自检判停 / 同步清单）本身都写着「回去重跑那一步、补证据」，
            对「已经做完且验证通过」的任务，模型照做 → 再把冒烟测试跑一遍（白烧 token）。
       现在：收工信号先认、最先判停（词表宽，但不认疑问 / 待办 / 阻塞；判据只看本轮答复，
       所以「连续几轮都在说完成」这种情况每一步都会就地停），连同步清单轮都不再追；
       同步清单轮另有跨批累计的 TODO_SYNC_TOTAL_MAX 硬上限（用户下一句话即清零），治
       「模型每轮改一点清单、轮轮出新问号，TODO_SYNC_MAX 按批重算 → 一路追到 AUTO_CAP」。
       两条指令正文同时收紧：只准重跑「自检发现有问题」的步骤，已跑绿的不许重跑。
     · 自检纪律落在系统提示（见 app-assist.js 的 SELF_CHECK_DISCIPLINE）：
       分阶段自检 + 交付前全检，发现问题先自行修复并重跑，修不好才告知用户；
       关键结论必须带证据（URL / 命令输出 / 截图路径），无证据不下断言。

   本文件自包含：只挂 window.LongRun，并在调用期取 app-assist.js 的会话态与发送口
   （classic script，顶层函数即 window 成员），不反向依赖加载顺序。
   ========================================================================== */
"use strict";

(function () {
  const $ = (s) => document.querySelector(s);
  const T = (zh) => {
    try {
      if (window.I18n && typeof window.I18n.t === "function") return window.I18n.t(zh);
    } catch (_) {}
    return zh;
  };
  const toastSafe = (msg, kind) => {
    try { if (typeof window.toast === "function") window.toast(msg, kind || "ok"); } catch (_) {}
  };

  /* 安全上限：不是「到点问人」，是防跑飞（用户已确认不自动中断）。 */
  const AUTO_CAP = 30;
  /* 连续跑多久算「这活跨重启」：给一次提升为长周期任务图的建议（只建议，不自动改图）。 */
  const SUGGEST_AFTER_ROUNDS = 8;
  const SUGGEST_AFTER_MS = 90 * 60 * 1000;
  /* 「清单里还有未确认条目（?）」时最多补几轮清单同步：补到模型把状态写对为止，
     但绝不无限补 —— 到顶就停并在「模式」chip 上说明原因，让人接手看一眼。
     TODO_SYNC_MAX 是「同一批问号」的配额（模型换了新条目就按新批重算）；
     TODO_SYNC_TOTAL_MAX 是**跨批累计**的总闸（本轮修复）：模型每轮改一点清单就出新一批
     问号，按批重算等于没有上限 → 一路追到 AUTO_CAP 并把冒烟测试反复重跑。用户手动发一句话
     即清零（见 app-assist.js agentSessionSend 的非自动轮），所以它只掐「无人干预的空转」。 */
  const TODO_SYNC_MAX = 2;
  const TODO_SYNC_TOTAL_MAX = 6;

  /* 本轮答复里的「已完成 / 已停手」信号：命中就不自动续跑（自检判停的第一条）。
     词表必须盖住模型的日常收工写法 —— 老表只有「全部完成 / 已交付」那一小撮，模型写
     「改完了」「已修复」「跑绿了」「修好了」全不认，于是对着一份已经交付的产出又追一轮
     （用户报的现场：AI 说完成后自动续跑仍追轮，最后把冒烟测试重跑了一遍）。
     另配否定词：正文里还有「还没做完 / 待办 / 阻塞」这类句子时不算收工（见 hasDoneSignal）。 */
  const DONE_RE = /(全部完成|已完成全部|任务完成|任务已完成|已完成本任务|完成本任务|已完成|已完成修复|修复完成|修改完成|改完|改好了|修好了|已修复|已改好|已完成并验证|已交付|全部交付|交付完成|验收通过|无需继续|不需要继续|没有下一步|无下一步|工作已完成|目标已达成|已达成目标|已解决|已闭环|告一段落|跑绿|全绿|已验证通过|验证通过|自检通过|收工|到此为止|all done|task complete|is complete|completed successfully|nothing (left|more)|no further|no more (work|steps)|ready to ship)/i;
  /* 正文里这些词一出现 → 这份答复不是收工（还在列待办 / 报阻塞 / 要人拍板 / 自认没验完）。
     注意别把「交付清单 … 待办 0 条」这种收工口吻误判成未收工：只在真正的未完成语义上命中
     （还有待办 / 待办项 / to-do 清单），单独一个「待办」不算。 */
  const NOT_DONE_RE = /(还有待办|待办项|有待办|未完成|没做完|还没|尚未|阻塞|被阻塞|卡住|需要你|请你确认|等你确认|需要确认|无法继续|做不到|未验证|验证失败|暂未|稍后继续|下一步计划|next step|to-?do|blocked|need your|please confirm)/i;

  /* 正文里出现收工信号 → 不再自动追轮（自检判停第一条的判据，抽成函数便于审计） */
  function hasDoneSignal(text) {
    const t = String(text || "");
    if (!t.trim()) return false;
    if (!DONE_RE.test(t)) return false;
    return !NOT_DONE_RE.test(t);
  }

  const st = {
    auto: {},        // sid → 自动续跑开关（缺省 true）
    ledger: {},      // sid → { rounds, startedAt, lastAt, tokens }
    stop: {},        // sid → 上次自动停止的原因（画在 chip 上）
    suggested: {},   // sid → 已给过「提升为长周期任务图」建议
    busy: {},        // sid → 正在发续跑指令，防重复
  };
  window.LongRun = st;

  const ses = () => {
    try {
      return typeof window.agentSessionState === "function" ? window.agentSessionState() : null;
    } catch (_) {
      return null;
    }
  };
  const byId = (sid) => {
    try {
      return typeof window.agentSessionById === "function" ? window.agentSessionById(sid) : null;
    } catch (_) {
      return null;
    }
  };
  /* 这条会话是不是用户此刻正在看的那条：提示只对看得见的那条弹（后台会话静默续跑）。 */
  const agentViewOf = (sid) => {
    try {
      const s = ses();
      return !!(s && s.id === sid);
    } catch (_) {
      return false;
    }
  };

  st.autoOn = function (sid) {
    if (!Object.prototype.hasOwnProperty.call(st.auto, sid)) st.auto[sid] = true;
    return st.auto[sid];
  };
  st.setAuto = function (sid, on) {
    st.auto[sid] = !!on;
    if (!on) st.stop[sid] = "已关闭自动续跑";
    else delete st.stop[sid];
    st.paint();
    try {
      toastSafe(on ? T("自动续跑已开启（不再自动追轮）") : T("自动续跑已关闭（本轮跑完就停）"), on ? "ok" : "warn");
    } catch (_) {}
  };
  st.toggleAuto = function () {
    const s = ses();
    if (!s) return;
    st.setAuto(s.id, !st.autoOn(s.id));
  };

  /* 累计台账：轮数 / 起止时间 / 累计 token（有用量字段就累，没有就不显示 token）。 */
  function ledgerOf(sid) {
    if (!st.ledger[sid]) st.ledger[sid] = { rounds: 0, startedAt: 0, lastAt: 0, tokens: 0 };
    return st.ledger[sid];
  }
  st.noteRound = function (sid, tokens) {
    const l = ledgerOf(sid);
    l.rounds += 1;
    l.lastAt = Date.now();
    if (!l.startedAt) l.startedAt = Date.now();
    const n = Number(tokens);
    if (Number.isFinite(n) && n > 0) l.tokens = (l.tokens || 0) + n;
    st.paint();
  };
  function humanMs(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
  }
  function statText(sid) {
    const l = st.ledger[sid];
    if (!l || !l.rounds) return "";
    const parts = [T("已续 ") + l.rounds + T(" 轮"), humanMs((l.lastAt || Date.now()) - (l.startedAt || Date.now()))];
    if (l.tokens) parts.push((l.tokens >= 1000 ? (l.tokens / 1000).toFixed(1) + "k" : l.tokens) + " tok");
    if (st.stop[sid]) parts.push(st.stop[sid]);
    return parts.join(" · ");
  }

  /* 开关 + 累计状态回显。
     本轮需求：输入区原来那枚独立的「自动续跑」chip 已收进「模式」菜单（唯一真源是
     本模块的 st.auto，缺省开），所以这里不再画自己那枚 chip，改成把状态回显给：
       · 「模式」菜单里那一行开关（index.html #agentModeMenu，构件在 app-assist.js）；
       · 「模式」chip 的摘要小字（app-assist.js 的 paintAgentModeChip 按同一判据算）。
     两者都是软依赖：app-assist.js 还没加载 / 那里没有这套 DOM，就只跳过回显，开关本身照常。 */
  st.paintModeChip = function () {
    const s = ses();
    const sid = s && s.id;
    if (typeof window.paintAgentModeChip === "function") {
      try { window.paintAgentModeChip(); } catch (_) {}
    }
    /* 累计台账（轮数 / 时长 / token）照旧只做「给你看」的小字：挂在「模式」chip 的 tooltip
       末尾，不再单独占一枚 chip —— 阀值口径一字未改（不拦人、只在安全上限自动停）。 */
    const chip = $("#agentModeTrigger");
    if (!chip || !sid) return;
    const stat = statText(sid);
    chip.title = stat ? chip.title + "\n" + stat : chip.title;
  };
  /* 老名字保留：本模块内部与其它模块调的都是 paint */
  st.paint = st.paintModeChip;

  /* 轮末判据：本轮答复该不该触发下一轮（自检判停） */
  function lastAssistantText(s) {
    const msgs = Array.isArray(s && s.messages) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && String(m.content || "").trim()) return String(m.content);
    }
    return "";
  }
  /* 还没收口的清单条目条数：
       null = 没有清单（这条判据不表态）
          0 = 全部收口（done / skipped）
        > 0 = 还有待办 —— 进行中（active）、未确认（unknown / 面板上的「?」）、待办、失败
             全算在内。
     两个坑都在这里钉死：
       ① 词表必须与落库状态同源：agentApplyTodoWrite 把模型的 in_progress 归一成
          「active」、completed 归一成「done」，这里再写 in_progress 就永远匹配不上 ——
          清单里明明有在做的条目，判据却回报 0（「清单已跑完」），自动续跑当场停住。
       ② 未确认（?）必须是「未收口」：agentFinalizeTodos 在轮末把 pending / active 标成
          unknown，模型要是没在那轮里再写一次 todo_write 收口，面板上就留下「?」；
          把它当收口 = 自动续跑不但不补那一轮，还会亲手把这份半截清单判成「已完成」，
          而模型下一轮仍会看到它，于是这种「任务其实做完了、清单却挂着一串问号」
          的状态会一直留在会话里。 */
  function todosOpen(s) {
    const list = Array.isArray(s && s.todos) ? s.todos : [];
    if (!list.length) return null; // 没有清单 = 这条判据不表态
    return list.filter((x) => x && x.status !== "done" && x.status !== "skipped").length;
  }
  /* 未确认条目的内容集合（按内容比对，不看顺序）：判断「模型这一轮是否真的回应了这批问号」
     —— 要么把状态写清（问号消失 / 变少），要么这次写的清单换了一批新条目（新条目本来没
     执行过，问号正常，该继续干活）。两者都不是 = 同一批条目原样挂着问号，再追也是白追。
     集合大小就是「未确认条目」的条数（面板上的「?」）。 */
  function todosUnknownSet(s) {
    const list = Array.isArray(s && s.todos) ? s.todos : [];
    const set = new Set();
    for (const x of list)
      if (x && x.status === "unknown" && x.content) set.add(String(x.content));
    return set;
  }
  function sameUnknownSet(a, b) {
    if (!a || !b || a.size === 0 || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  /* ── 本轮答复的收工判据（唯一真源，审计一处就够）─────────────────────────────
     hasDoneSignal = 这一轮正文里明确收工（词表见 DONE_RE / NOT_DONE_RE）。
     判据只看**本轮的最终答复**：命中就地判停（连同步清单轮都不再追）——
     现场是：模型上一轮已写完「改完了 / 全部完成 + 交付清单」，自动续跑又发一条
     「回去重跑那一步、补证据」，模型照做 → 冒烟测试被白白重跑一遍。 */
  function noteSyncRound(s) {
    const n = (Number(s._todoSyncRounds) || 0) + 1;
    s._todoSyncRounds = n;
    return n;
  }

  /* 「同步清单」轮：只让模型把 todo_write 的每条状态写对。 */
  function todoSyncDirective(n) {
    return (
      "【自动续跑 · 同步任务清单】会话清单里还有 " + n + " 条没有确认状态（面板上显示「?」），" +
      "而你上一轮的答复已经看不出下一步 —— 这份清单不能再挂着问号算收尾。\n" +
      "本轮按顺序做三件事，不要问我是否继续：\n" +
      "1) 逐条核对这 " + n + " 条：每一件到底做完了、跳过了、还是没做完（证据优先用**已经跑出来的**：文件绝对路径 / 已跑过的命令输出 / 来源 URL；**不要去重跑已经跑绿的测试或已经验过的步骤**，已有的结果就是证据；真的没有证据才说没查到）；\n" +
      "2) 调用 todo_write 把**整份清单**重写一遍（整表替换，不是局部改）：做完的写 completed、跳过或不再需要的写 completed 并在正文一句话说明、确实没做完的保持 pending 或 in_progress —— 一条都不许留在模糊状态；\n" +
      "3) 若还有明确没做完的事（含自己发现没做干净、或前面某步结论无证据要重跑）：本轮按第「自检判停」那套口径直接接着做，用工具真做；**只准重跑自检发现有问题的那一步**；\n" +
      "4) 若确实全部收口：写完 todo_write 后用一句话明确收工（写「全部完成」并给交付清单），我会停止追轮；\n" +
      "5) 卡住了就用 browser_help（kind:\"blocked\"）说明试过什么、需要什么，等我协助。\n" +
      "禁止：只发 todo_write 却不核对（别为了消掉问号把没做的也标成完成）；也禁止为了续跑而续跑 —— 已经做完且验证通过的事（含刚刚跑绿的冒烟测试）一律不许重跑，重跑等于原地空转、白烧 token。"
    );
  }

  st.afterRound = async function (s, outcome) {
    if (!s || !s.id) return;
    const sid = s.id;
    const l = ledgerOf(sid);
    /* 台账收一拍（本轮真实耗时 = 上一次收尾到现在；token 有就用量事件里的累计值） */
    l.lastAt = Date.now();
    if (!l.startedAt) l.startedAt = Date.now();
    st.paint();

    /* 不续跑的情形（一律静默，不打扰）：用户关掉了 / 本轮失败或被打断 / 会话没了 */
    if (!st.autoOn(sid)) return;
    if (outcome && outcome !== "ok") {
      st.stop[sid] = outcome === "cancelled" ? T("已终止") : T("本轮出错，等你处置");
      st.paint();
      return;
    }
    if (typeof window.agentSessionById === "function" && !byId(sid)) return;

    /* 本轮收工判据先算一次：下面的判停②、同步轮、续跑轮读的都是同一份结论 */
    const text = lastAssistantText(s);
    const doneNow = hasDoneSignal(text);

    const open = todosOpen(s);
    /* 自检判停①：清单已经全部收口（没有待办 / 没有未确认）→ 不续。
       这一条必须排在任何自动停止之前：清单是真源，它说收口了才是真的收口。 */
    if (open === 0) {
      st.stop[sid] = T("清单已跑完");
      st.paint();
      return;
    }

    /* 自检判停②·收工判停（本轮修复 · 必须排在「清单同步」之前）：
       本轮答复已明确收工 → 到此为止，不再追任何轮（含同步清单轮）。
       为什么提前：老口径把收工判停放最后，本轮只要还剩一条「?」它就不参与判停 ——
       于是「AI 已经说完成、自动续跑仍追一轮」的现场里，追的那一轮又把冒烟测试跑了一遍。
       清单没写对这件事，用 chip 上的原因说清楚（用户看得见、说一句话就能接着跑），
       比再花一轮把已经做完的活重跑一遍值当。
       这一条同时就是「空转闸」：收工轮一律就地停、连续收工轮同样停（判据只看本轮答复），
       所以不存在「连续几轮都在说完成还接着追」的组合。 */
    if (doneNow) {
      st.stop[sid] = T("目标已达成");
      st.paint();
      return;
    }

    /* ①·补 清单同步轮：「任务做完了、清单却挂着一串问号」的唯一修法就是让模型自己写对。
       为什么在这一步拦：agentFinalizeTodos 在轮末把没跑完的条目标成「未确认（?）」，
       模型要是没在那轮里再写一次 todo_write，清单就永远停在问号上。这里补一轮，只让它把
       状态写对。
       注意：走到这里说明本轮答复**还没有收工信号**（收工轮已在上面判停）—— 所以补的这一轮
       是「活还没干完、清单也没写清」，不是「已经做完却回头验收」。
       三道闸防纠缠（用户口径：不自动中断、别来回拉扯）：
        · 配额：同一批问号最多补 TODO_SYNC_MAX 轮，到顶停下说明原因；
        · 总闸：跨批累计最多 TODO_SYNC_TOTAL_MAX 轮（模型每轮改一点清单就出新一批问号，
          按批重算等于没有上限 —— 一路追到 AUTO_CAP 就会把验证步骤反复重跑；用户下一句清零）；
        · 同一批认账：模型这一轮已经写过 todo_write，但这几条问号**一个没变**（内容集合
          完全一致）→ 它已经表态过了，再追也是白追，停在这里把清单摆给用户看。 */
    const unknownSet = todosUnknownSet(s);
    const unknown = unknownSet.size;
    if (unknown > 0) {
      const lastSet = s._todoSyncUnknownSet;
      const answered = Array.isArray(lastSet) && sameUnknownSet(new Set(lastSet), unknownSet);
      const tries = Number(s._todoSyncTries) || 0;
      const total = Number(s._todoSyncRounds) || 0;
      if (answered || tries >= TODO_SYNC_MAX || total >= TODO_SYNC_TOTAL_MAX) {
        st.stop[sid] = answered
          ? T("清单未收口（模型未确认这 ") + unknown + T(" 项）")
          : total >= TODO_SYNC_TOTAL_MAX
            ? T("清单未收口（同步已补 ") + total + T(" 轮，已停）")
            : T("清单未收口（已补 ") + TODO_SYNC_MAX + T(" 轮）");
        st.paint();
        return;
      }
      if (!s._todoSyncPending && !st.busy[sid]) {
        st.busy[sid] = 1;
        try {
          if (typeof window.agentSessionSend === "function") {
            /* 同步轮不算「自动续跑轮」，不进台账轮数（只在提示里报一句） */
            s._todoSyncTries = tries + 1;
            noteSyncRound(s);
            /* 记下这一批问号的内容：下一轮问号一个没变 = 模型已经答过，不再追 */
            s._todoSyncUnknownSet = Array.from(unknownSet);
            s._todoSyncPending = true;
            if (agentViewOf(sid)) {
              toastSafe(
                T("清单里有未确认条目：已自动补一轮，让模型标清任务状态"), "warn",
              );
            }
            await window.agentSessionSend(todoSyncDirective(unknown), {
              sessionId: sid,
              _autoContinue: true,
              /* 标记这是一轮「清单同步」：宿主据此不注入「任务流程」指令
                 （见 app-assist.js agentSessionSend 的 todoSyncMsg） */
              _todoSync: true,
            });
          }
        } catch (_) {
          /* 发不出去（会话不存在 / 网络）→ 保持原样，下一轮用户手动发即可 */
        } finally {
          /* 发出去了就摘旗：下一轮若又冒出问号，还能（在配额内）再补一次 */
          s._todoSyncPending = false;
          st.busy[sid] = 0;
        }
        st.paint();
        return;
      }
    }

    /* 防跑飞：安全上限（不是到点问人，是唯一的自动停止） */
    if (l.rounds >= AUTO_CAP) {
      st.stop[sid] = T("已到安全上限 ") + AUTO_CAP + T(" 轮，已停");
      st.paint();
      toastSafe(T("自动续跑已到安全上限（") + AUTO_CAP + T(" 轮），已停下；确需继续请再发一句。"), "warn");
      return;
    }
    /* 跨重启的活 → 给一次「提升为长周期任务图」的建议（只建议，不自动改图） */
    try {
      const long = (Date.now() - (l.startedAt || Date.now()) > SUGGEST_AFTER_MS) || l.rounds >= SUGGEST_AFTER_ROUNDS;
      if (long && !st.suggested[sid]) {
        st.suggested[sid] = 1;
        toastSafe(
          T("这活看着要跑很久：可以把它提升为「长周期任务图」，重启后也能接着跑（会话里说一句我就给你搭）。"),
          "warn",
        );
      }
    } catch (_) {}

    /* 该续：发一条「自检 + 续跑」指令。内容按用户口径 —— 先对照原目标自查，再决定
       继续还是收工；不许为了续跑而续跑，也不许把可疑结果当定稿。 */
    if (st.busy[sid]) return;
    st.busy[sid] = 1;
    const directive =
      "【自动续跑 · 自检判停】上一轮已结束，但你的产出尚未显示目标已达成。请按这套口径接着做，不要问我是否继续：\n" +
      "1) 先对照最初的目标做一次自检：哪些已确认完成（各带什么证据：来源 URL / 命令输出 / 截图路径），哪些还没做、差在哪；\n" +
      "2) 自检若发现前面某步的输出**确实有问题**或关键结论**真的缺证据** → 只把**那一步**回去修 / 补证据并重跑，不要把它当定稿往后带；\n" +
      "3) 若还有明确的下一步 → 直接继续做（用工具真做，不要只写计划）；\n" +
      "4) 若已经全部完成 → 用一句话明确收工（写「全部完成」并给出交付清单），我会停止追轮；\n" +
      "5) 若卡住了 → 用 browser_help（kind:\"blocked\"）说明你试过什么、需要什么，等我协助；\n" +
      "6) 禁止空转：**已经跑绿 / 已经验证通过的步骤（含冒烟测试）一律不许重跑**，已有的结果就是证据；不要重复已经做过且没有新信息的事，不要为了显得忙而重跑同一份调研。";
    try {
      if (typeof window.agentSessionSend === "function") {
        await window.agentSessionSend(directive, { sessionId: sid, _autoContinue: true });
        l.rounds += 1;
        l.lastAt = Date.now();
        st.paint();
      }
    } catch (_) {
      /* 发不出去（会话不存在 / 网络）→ 停在这里，下一轮用户手动发即可 */
    } finally {
      st.busy[sid] = 0;
    }
  };

  /* 会话重绘钩子：把开关态同步到「模式」chip 与菜单（开关自身在 app-assist.js 的菜单里） */
  function wire() {
    /* 开关的点击入口已收进「模式」菜单（app-assist.js buildAgentModeMenu → st.toggleAuto），
       这里只做状态回显：模块就绪时先把「模式」chip 刷一遍（会话重绘时再刷）。 */
    try { st.paint(); } catch (_) {}
    /* 会话重绘后顺手刷一遍回显（流式事件很密，只做几次属性读，几乎零成本） */
    if (typeof window.renderAgentSession === "function" && !window.renderAgentSession.__lrHooked) {
      const rc = window.renderAgentSession;
      const wrapped = function () {
        const r = rc.apply(this, arguments);
        try { st.paint(); } catch (_) {}
        return r;
      };
      wrapped.__lrHooked = 1;
      window.renderAgentSession = wrapped;
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();