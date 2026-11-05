/* renderer/app-notify.js — 任务完成提醒（系统通知 + 应用内完成卡片）
 *
 * 本次需求：会话 / 模型任务跑完时，不只是响一声，还要**在用户看不到窗口时也能收到**。
 * 口径（与用户共识一一对应）：
 *   · 触发：智能会话 / Agent 一轮完成、媒体产物完成（图 / 视频 / 音乐 / 语音，不管来源是
 *     独立媒体节点还是画布上的超级节点 / 工作流）、模型停下来等你回应（提问 / 审批）；
 *     函数 / 执行节点那种毫秒级短活、被用户手动停止的、子代理行都不提醒。
 *   · 时机：只在应用不在前台（最小化 / 已收托盘 / 被别的窗口盖住）时弹。
 *   · 聚合：沿用完成音的 500ms 合并窗，窗内多项合成一条「N 项任务已完成」。
 *   · 文案：标题 = 任务名（会话标题 / 节点名 / 产物类型）；正文 = 最后一段回复首句或产物文件名。
 *   · 点击：恢复主窗并跳到来源（复用运行队列的 jumpRunQueueItem 跳转口径）；
 *     系统通知那条路由主进程转回来（notify:click），卡片这条就地跳。
 *   · 与应用内音效共存：声音仍由 app-db.js 的 playTaskDoneSound 发，这里只管弹。
 *   · 设置项：S.config.dsh.donePopup（默认开；只管弹窗，不管音效）。
 *
 * 为什么挂在这里而不是逐条埋钩子：完成判定的唯一收口是 app-db.js 的 dshRunQueueDoneCheck
 * （运行队列前后对比），它一处就覆盖了会话 / 节点 / 媒体 / 批处理。本文件只提供两个入口
 * （notifyTaskDone / notifyWaitingForUser），判定与副作用分开。
 */
(function () {
  "use strict";

  const MERGE_MS = 500; /* 与 DSH_DONE_SOUND_MERGE_MS 同口径：并行收尾合成一条 */
  const CARD_TTL_MS = 8000; /* 用户口径：约 8 秒后自动消失，悬停时暂停计时 */
  const CARD_MAX = 3; /* 卡片最多堆 3 张，多了先撤最老的，避免糊住右下角 */
  /* 收在托盘期间产生的卡片，用户可能很久以后才回到窗口：超过这个岁数就不再补弹，
     免得「一小时前的完成提示」在回来后突然冒出来（系统通知那条已经尽责了）。 */
  const CARD_STALE_MS = 10 * 60 * 1000;

  let batch = [];
  let batchTimer = null;
  let trayLastCount = -1;
  const cards = []; /* { el, timer, remain, startedAt } */

  function dshCfg() {
    try {
      return (S && S.config && S.config.dsh) || {};
    } catch (_) {
      return {};
    }
  }

  function popupOn() {
    return dshCfg().donePopup !== false;
  }

  /* 应用此刻是否「用户看不到」：页面不可见（收到托盘 / 最小化）或页面在但没焦点（被盖住）。
     document.hasFocus() 在 Electron 隐藏窗口时一定是 false；两条并起来判更稳。 */
  function userAway() {
    try {
      if (typeof document === "undefined") return false;
      if (document.visibilityState !== "visible") return true;
      return !document.hasFocus();
    } catch (_) {
      return false;
    }
  }

  /* ── 从运行队列的快照里挑出「该提醒的完成」────────────────────────────── */
  function mediaOutputName(node) {
    try {
      const p = String(
        (typeof mediaGenOutputRaw === "function" ? mediaGenOutputRaw(node) : "") ||
          (node && node.outputPath) ||
          "",
      ).trim();
      if (!p) return "";
      const base = p.split(/[\\/]/).filter(Boolean).pop() || "";
      return base;
    } catch (_) {
      return "";
    }
  }

  /* 超级节点 / 工具节点里是否有媒体生成后代（工作流跑完出图 / 出片也算媒体产物完成） */
  function subtreeMakesMedia(shell, depth) {
    if (!shell || shell.kind !== "super" || (depth || 0) > 3) return false;
    let kids = [];
    try {
      if (typeof superChildrenOf === "function" && shell.id) kids = superChildrenOf(shell.id) || [];
    } catch (_) {
      kids = [];
    }
    if (!kids.length) return false;
    for (const k of kids) {
      if (!k) continue;
      try {
        if (typeof isMediaGenNode === "function" && isMediaGenNode(k)) return true;
      } catch (_) {}
      if (k.kind === "super" && subtreeMakesMedia(k, (depth || 0) + 1)) return true;
    }
    return false;
  }

  function nodeMakesMedia(node) {
    if (!node) return false;
    try {
      if (typeof isMediaGenNode === "function" && isMediaGenNode(node)) return true;
    } catch (_) {}
    return subtreeMakesMedia(node, 0);
  }

  function clip(s, n) {
    const t = String(s || "")
      .replace(/\s+/g, " ")
      .trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  /* 会话最后一段回复的首句（够判断「要不要现在回去看」，又不把正文塞进通知） */
  function sessionSnippet(st) {
    try {
      const msgs = (st && st.messages) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== "assistant") continue;
        const raw = String(m.content || "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/[#*`>_~|-]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!raw) continue;
        const first = raw.split(/[。！？!?\n]/)[0] || raw;
        return clip(first, 60);
      }
    } catch (_) {}
    return "";
  }

  /* 开发块 / 工具节点的「绑定会话」在运行队列里被折进那一行（type=dev / node），
     不会有独立的 session 行（见 app.js collectRunQueueAll 的注释）。它们是真正的
     Agent 会话，跑完也该提醒 —— 会话 id 记在节点上，按最近的先找。 */
  function boundSessionRec(node, rec) {
    if (!node) return null;
    const ids = [];
    try {
      if (node.agentSessionId) ids.push(String(node.agentSessionId));
      if (Array.isArray(node.devSessionIds)) ids.push.apply(ids, node.devSessionIds);
      if (node.devSuggestSessionId) ids.push(String(node.devSuggestSessionId));
      if (Array.isArray(node.toolDevSessionIds)) ids.push.apply(ids, node.toolDevSessionIds);
      if (Array.isArray(node.fnDevSessionIds)) ids.push.apply(ids, node.fnDevSessionIds);
    } catch (_) {}
    if (!ids.length) return null;
    if (typeof agentSessionById !== "function") return null;
    for (const id of ids) {
      let st = null;
      try {
        st = agentSessionById(String(id));
      } catch (_) {}
      if (!st) continue;
      return {
        title: clip(st.title || rec.title || I18n.t("会话"), 48),
        body: sessionSnippet(st) || I18n.t("这一轮已经跑完了"),
        jump: { type: "session", id: String(st.id) },
      };
    }
    return null;
  }

  /* 队列快照 → { title, body, jump }；不合格（不在提醒范围）返回 null */
  function recOf(rec) {
    if (!rec) return null;
    const type = String(rec.type || "");
    if (type === "subagent") return null; /* 与父会话同时收尾，提醒会重复 */
    if (type === "session") {
      let st = rec.sess || null;
      if (!st && typeof agentSessionById === "function") {
        try {
          st = agentSessionById(rec.id);
        } catch (_) {}
      }
      const title = clip((st && st.title) || rec.title || I18n.t("会话"), 48);
      return {
        title,
        body: sessionSnippet(st) || I18n.t("这一轮已经跑完了"),
        jump: { type: "session", id: String(rec.id || "") },
      };
    }
    if (type === "media") {
      const name = mediaOutputName(rec.node);
      return {
        title: clip(rec.title || I18n.t("媒体生成"), 48),
        body: name || I18n.t("产物已生成"),
        jump: {
          type: "node",
          id: String(rec.id || ""),
          wfId: String(rec.wfId || ""),
          crossWf: !!rec.crossWf,
        },
      };
    }
    if (type === "node" || type === "dev") {
      /* 先看它名下有没有正在收尾的绑定会话（开发块 / 工具节点 / 函数节点的开发会话） */
      const sessRec = boundSessionRec(rec.node, rec);
      if (sessRec) return sessRec;
      /* 画布节点本身不提醒；但超级节点 / 工作流里跑出图、跑出片的算「媒体产物完成」 */
      if (!nodeMakesMedia(rec.node)) return null;
      const name = mediaOutputName(rec.node);
      return {
        title: clip(rec.title || I18n.t("媒体生成"), 48),
        body: name || I18n.t("产物已生成"),
        jump: {
          type: "node",
          id: String(rec.id || ""),
          wfId: String(rec.wfId || ""),
          crossWf: !!rec.crossWf,
        },
      };
    }
    return null;
  }

  /* ── 应用内完成卡片（系统通知被系统勿扰拦掉时的兜底）──────────────────── */
  function stackEl() {
    let el = document.getElementById("notifyStack");
    if (el) return el;
    if (typeof document === "undefined" || !document.body) return null;
    el = document.createElement("div");
    el.id = "notifyStack";
    el.className = "notify-stack";
    /* aria-live：读屏用户也能收到「任务完成」这件事（这条提醒本身就是无障碍需求） */
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    return el;
  }

  function dropCard(entry, immediate) {
    const i = cards.indexOf(entry);
    if (i >= 0) cards.splice(i, 1);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.el) return;
    if (immediate) {
      try {
        entry.el.remove();
      } catch (_) {}
      return;
    }
    try {
      entry.el.classList.add("notify-card-out");
      setTimeout(() => {
        try {
          entry.el.remove();
        } catch (_) {}
      }, 180);
    } catch (_) {}
  }

  function startCardTimer(entry) {
    if (!entry || entry.timer) return;
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => {
      entry.timer = null;
      dropCard(entry, false);
    }, Math.max(400, entry.remain || CARD_TTL_MS));
  }

  function pauseCard(entry) {
    if (!entry || !entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    const spent = Date.now() - (entry.startedAt || Date.now());
    entry.remain = Math.max(400, (entry.remain || CARD_TTL_MS) - spent);
  }

  function pushCard(rec, merged) {
    const host = stackEl();
    if (!host) return;
    while (cards.length >= CARD_MAX) dropCard(cards[0], true);

    const el = document.createElement("div");
    el.className = "notify-card";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.title = merged ? I18n.t("点击查看详情") : I18n.t("点击定位到该任务");

    const hd = document.createElement("div");
    hd.className = "notify-card-hd";
    const dot = document.createElement("span");
    dot.className = "notify-card-dot";
    const title = document.createElement("span");
    title.className = "notify-card-title";
    title.textContent = rec.title;
    const x = document.createElement("button");
    x.className = "notify-card-x";
    x.type = "button";
    x.title = I18n.t("关闭");
    x.textContent = "✕";
    x.onclick = (ev) => {
      try {
        ev.stopPropagation();
      } catch (_) {}
      dropCard(entry, false);
    };
    hd.appendChild(dot);
    hd.appendChild(title);
    hd.appendChild(x);

    const body = document.createElement("div");
    body.className = "notify-card-body";
    body.textContent = rec.body || "";

    el.appendChild(hd);
    if (rec.body) el.appendChild(body);
    host.appendChild(el);

    const entry = { el, timer: null, remain: CARD_TTL_MS, startedAt: 0, createdAt: Date.now() };
    cards.push(entry);
    el.onmouseenter = () => pauseCard(entry);
    el.onmouseleave = () => startCardTimer(entry);
    const jump = () => {
      dropCard(entry, true);
      jumpTo(rec.jump);
    };
    el.onclick = jump;
    el.onkeydown = (ev) => {
      if (ev && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        jump();
      }
    };
    startCardTimer(entry);
    return entry;
  }

  /* 页面重新可见（从托盘唤起 / 从最小化回来）：把还没到期的卡片重新开始计时 ——
     前台弹的时候它可能整段计时都处在隐藏态，白白过期等于没提醒。 */
  function rearmCards() {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") {
      for (const c of cards) pauseCard(c);
      return;
    }
    for (const c of cards.slice()) {
      if (Date.now() - (c.createdAt || 0) > CARD_STALE_MS) dropCard(c, true);
      else startCardTimer(c);
    }
  }

  try {
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", rearmCards);
      window.addEventListener("focus", rearmCards);
    }
  } catch (_) {}

  /* ── 跳转（复用运行队列的口径）────────────────────────────────────────── */
  async function jumpTo(jump) {
    if (!jump || !jump.type) return;
    try {
      if (jump.type === "session") {
        const st =
          typeof agentSessionById === "function" ? agentSessionById(String(jump.id || "")) : null;
        if (typeof jumpRunQueueItem === "function")
          return await jumpRunQueueItem({ type: "session", id: String(jump.id || ""), sess: st });
        return;
      }
      const id = String(jump.id || "");
      const node =
        (typeof runQueueLookupNode === "function" ? runQueueLookupNode(id) : null) ||
        (typeof nodeById === "function" ? nodeById(id) : null);
      if (typeof jumpRunQueueItem === "function")
        return await jumpRunQueueItem({
          type: "node",
          id,
          node,
          wfId: String(jump.wfId || ""),
          crossWf: !!jump.crossWf,
        });
    } catch (_) {}
  }

  /* ── 对外入口 ─────────────────────────────────────────────────────────── */
  /* 完成批处理：dshRunQueueDoneCheck 每判定出一批就调一次；500ms 内的后续批次并进同一条。 */
  function notifyTaskDone(recs) {
    if (!popupOn()) return;
    if (!Array.isArray(recs) || !recs.length) return;
    let added = 0;
    for (const r of recs) {
      const n = recOf(r);
      if (!n) continue;
      batch.push(n);
      added++;
    }
    if (!added) return;
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const list = batch;
      batch = [];
      flush(list);
    }, MERGE_MS);
  }

  function flush(list) {
    if (!popupOn() || !list || !list.length) return;
    /* 时机口径：只在应用不在前台时提醒（用户正盯着看的时候不打扰） */
    if (!userAway()) return;
    const one = list.length === 1 ? list[0] : null;
    const title = one ? one.title : I18n.t("{n} 项任务已完成", { n: list.length });
    let body;
    if (one) body = one.body;
    else {
      const names = list.map((x) => x.title).slice(0, 3).join("、");
      body = names + (list.length > 3 ? " …" : "");
    }
    /* ① 系统通知（Windows 操作中心，最小化 / 收托盘时唯一的可见提醒） */
    try {
      if (window.api && typeof window.api.notifyShow === "function")
        window.api.notifyShow({ title, body, jump: one ? one.jump : null });
    } catch (_) {}
    /* ② 应用内卡片兜底（系统勿扰 / 开发态通知不弹时仍然看得见） */
    pushCard({ title, body, jump: one ? one.jump : null }, !one);
  }

  /* 模型停下来等你回应（提问 / 审批卡）：非前台时同样发一条系统通知。
     应用内卡片不重复做 —— 提问卡本身就在界面上（renderer/app-db.js 的 ix 面板）。 */
  function notifyWaitingForUser(kind, data, src) {
    if (!popupOn()) return;
    if (!userAway()) return;
    try {
      const label = (src && src.label) || "";
      const isApproval = String(kind || "").indexOf("approval") >= 0;
      const title = (label ? clip(label, 40) + " · " : "") +
        (isApproval ? I18n.t("等待你确认") : I18n.t("等待你回应"));
      let body = "";
      try {
        const qs = (data && data.questions) || [];
        const q0 = qs[0];
        body = String((q0 && (q0.question || q0.prompt || q0.title)) || (data && data.message) || "");
      } catch (_) {}
      if (!body) body = I18n.t("模型停在这一步，等你回答后才继续");
      window.api.notifyShow({ title, body: clip(body, 90), jump: null });
    } catch (_) {}
  }

  /* 托盘「运行中任务数」/「全部终止运行」的可用性：只在数量变化时上报一次 */
  function notifySyncTrayRunning(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v === trayLastCount) return;
    trayLastCount = v;
    try {
      if (window.api && typeof window.api.traySetRunning === "function")
        window.api.traySetRunning(v);
    } catch (_) {}
  }

  /* 主进程侧两条通道：点系统通知 → 跳来源；托盘菜单「全部终止运行」→ stopAllRuns */
  try {
    if (window.api && typeof window.api.onNotifyClick === "function")
      window.api.onNotifyClick((jump) => jumpTo(jump));
    if (window.api && typeof window.api.onTrayStopAll === "function")
      window.api.onTrayStopAll(() => {
        try {
          if (typeof stopAllRuns === "function") stopAllRuns();
        } catch (_) {}
      });
  } catch (_) {}

  window.MTNodeNotify = {
    notifyTaskDone,
    notifyWaitingForUser,
    notifySyncTrayRunning,
    userAway,
    jumpTo,
  };
})();

/* 具名全局：app-db.js / app.js 按名字调用（本仓渲染层就是这套全局函数口径） */
function notifyTaskDone(recs) {
  try {
    window.MTNodeNotify.notifyTaskDone(recs);
  } catch (_) {}
}
function notifyWaitingForUser(kind, data, src) {
  try {
    window.MTNodeNotify.notifyWaitingForUser(kind, data, src);
  } catch (_) {}
}
function notifySyncTrayRunning(n) {
  try {
    window.MTNodeNotify.notifySyncTrayRunning(n);
  } catch (_) {}
}
