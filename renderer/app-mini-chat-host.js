/* app-mini-chat-host.js — 快捷会话小窗的「主窗口一侧」代理（renderer/app-mini-chat-host.js）。
 *
 * 为什么要这一层：agent 的运行态**只在主窗口渲染层**（agentSessionSend / sessionIsRunning /
 * stopSessionRuns 全在 app-assist.js、app-db.js、app.js），主进程只持有 session:* 存储 IPC。
 * 所以独立小窗（mini-chat-window.js 那只 BrowserWindow）不自己跑 agent，而是把四件事
 * 中继过来，由本文件在主窗口里执行：
 *
 *   op            args                    本文件做的
 *   state         {}                       组一份 {sessions, selectedId, selected}
 *   select        {id}                     记住小窗选中的会话，回一份最新 state
 *   newSession    {}                       按主窗当前画布 + 默认模型新建一条（不切主窗视图）
 *   send          {sessionId, text}        走 agentSessionSend（忙则自动进发送队列，与主界面同源）
 *   stop          {id}                     stopSessionRuns（助手会话再补 assistStop）
 *   goto          {id}                     主窗切到会话视图并选中该条（主进程负责还原窗口与关小窗）
 *
 * 推送：小窗开着时每 800 ms 组一次 state，与上一拍不同才经 window.api.miniChatPush 推过去
 * （主窗 → 主进程 → 小窗）。只在开着时跑，关掉即停（无空转）。
 *
 * 口径（用户共识）：小窗只显示「当前选中会话的最后一条 AI 回复」—— 不推思考、不推工具调用、
 * 不推历史；左栏取全部会话按最近更新前 20 条；新会话跟随主窗当前画布。
 */
(function () {
  "use strict";

  var api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.onMiniChatReq !== "function") return; /* 桥没挂上：整块静默退出 */
  if (window.__miniChatHostReady) return;
  window.__miniChatHostReady = true;

  var TOP_N = 20;
  var PUSH_MS = 800;
  var REPLY_MAX = 20000; /* 单条回复上限：够读结论，又不至于把 IPC 撑爆 */
  var selectedId = "";
  var miniOpen = false;
  var timer = null;
  var lastSig = "";

  function t(s) {
    try {
      return I18n.t(s);
    } catch (_) {
      return s;
    }
  }

  function sessionsArr() {
    try {
      return typeof agentSessions === "function" ? agentSessions() || [] : [];
    } catch (_) {
      return [];
    }
  }

  function lastAtOf(s) {
    try {
      if (typeof sessionLastAt === "function") {
        var v = sessionLastAt(s);
        if (v) return v;
      }
    } catch (_) {}
    return Number(s && s.updatedAt) || Number(s && s.createdAt) || 0;
  }

  function busyOf(st) {
    var busy = false;
    try {
      if (typeof sessionBusyForUi === "function") busy = !!sessionBusyForUi(st);
      else if (typeof sessionIsRunning === "function") busy = !!sessionIsRunning(st);
      else busy = !!(st && st.running);
    } catch (_) {
      busy = !!(st && st.running);
    }
    /* 助手会话由助手栏点火（runKey = "assist"），不写在会话自己的 running 位上 */
    try {
      if (st && st.assist && typeof S !== "undefined" && S.assistRunning)
        busy = busy || String(S.assistSessionId || "") === String(st.id);
    } catch (_) {}
    return busy;
  }

  function queuedOf(st) {
    return !!(st && Array.isArray(st.outbox) && st.outbox.length);
  }

  /** 会话正文里的最后一条指定角色消息（跳过空正文） */
  function lastOfRole(st, role, max) {
    var ms = (st && Array.isArray(st.messages) && st.messages) || [];
    for (var i = ms.length - 1; i >= 0; i--) {
      var m = ms[i];
      if (!m || m.role !== role) continue;
      var c = String(m.content == null ? "" : m.content).trim();
      if (!c) continue;
      return c.length > max ? c.slice(0, max) + "\n…" : c;
    }
    return "";
  }

  function topSessions() {
    var list = sessionsArr().filter(function (s) {
      return s && !s.archived;
    });
    list.sort(function (a, b) {
      return lastAtOf(b) - lastAtOf(a);
    });
    return list.slice(0, TOP_N);
  }

  /* ── 项目文件夹（本轮需求 · 共识 q1 / q2）────────────────────────────────
     小窗要让用户一眼看出「这条会话改的是哪个项目」。目录**不另算一套**：真源就是主窗
     现有的生效工作区（agentRunWorkspace：手填 > 所属画布项目根 > 画布工作目录 > 默认），
     否则小窗与主窗「工作区」chip 会各说一件事。宿主没挂这些函数（独立沙箱）时回空串，
     小窗按「未设置目录」显示，绝不编造路径。 */
  function wsOf(st) {
    var out = { ws: "", wsSrc: "" };
    try {
      if (!st || typeof agentRunWorkspace !== "function") return out;
      var p = String(agentRunWorkspace(st) || "").trim();
      if (!p) return out;
      out.ws = p;
      try {
        if (typeof agentWorkspaceInfo === "function") {
          var info = agentWorkspaceInfo(st) || {};
          if (info.source && typeof workspaceSourceLabel === "function")
            out.wsSrc = String(workspaceSourceLabel(info.source) || "");
        }
      } catch (_) {}
    } catch (_) {}
    return out;
  }

  function pickId(top) {
    if (selectedId && top.some(function (s) { return String(s.id) === selectedId; })) return selectedId;
    var act = "";
    try {
      act = String((typeof S !== "undefined" && S.agentActiveId) || "");
    } catch (_) {}
    if (act && top.some(function (s) { return String(s.id) === act; })) return act;
    return top.length ? String(top[0].id) : "";
  }

  /** 组一份小窗要的状态（只含它要画的东西） */
  async function buildState() {
    var top = topSessions();
    var sid = pickId(top);
    selectedId = sid;
    var sessions = top.map(function (s) {
      var w = wsOf(s);
      return {
        id: String(s.id),
        title: String(s.title || t("新会话")),
        busy: busyOf(s),
        queued: queuedOf(s),
        ws: w.ws,
        wsSrc: w.wsSrc,
      };
    });
    var selected = null;
    var st = sid ? sessionsArr().filter(function (s) { return String(s.id) === sid; })[0] : null;
    if (st) {
      /* 正文可能还在盘上（懒加载 / 重启后第一次选中）：只对选中的这一条读回来 */
      if (!st._lcLoaded && !st._lcMissing && typeof agentEnsureSessionBody === "function") {
        try {
          await agentEnsureSessionBody(st);
        } catch (_) {}
      }
      var wsel = wsOf(st);
      selected = {
        id: String(st.id),
        title: String(st.title || t("新会话")),
        busy: busyOf(st),
        queued: queuedOf(st),
        paused: !!st.paused,
        ws: wsel.ws,
        wsSrc: wsel.wsSrc,
        lastReply: lastOfRole(st, "assistant", REPLY_MAX),
        lastUser: lastOfRole(st, "user", 4000),
      };
    }
    return { sessions: sessions, selectedId: sid, selected: selected };
  }

  function pushNow() {
    if (!miniOpen) return;
    Promise.resolve()
      .then(buildState)
      .then(function (data) {
        var sig = "";
        try {
          sig = JSON.stringify(data);
        } catch (_) {
          sig = "";
        }
        if (sig && sig === lastSig) return; /* 没变化不推 */
        lastSig = sig;
        try {
          api.miniChatPush({ type: "state", data: data });
        } catch (_) {}
      })
      .catch(function () {});
  }

  function tick() {
    pushNow();
  }

  function startLoop() {
    if (timer) return;
    lastSig = ""; /* 下次开窗必推一拍（否则窗口会停在旧内容上） */
    timer = setInterval(tick, PUSH_MS);
    tick();
  }

  function stopLoop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function setOpen(open) {
    miniOpen = !!open;
    if (miniOpen) startLoop();
    else stopLoop();
  }

  /* ── 各 op 的实现 ──────────────────────────────────────────────────── */
  function findSession(id) {
    var sid = String(id || "");
    if (!sid) return null;
    var hit = sessionsArr().filter(function (s) { return String(s && s.id) === sid; })[0];
    return hit || null;
  }

  async function handle(op, args) {
    var a = args || {};
    if (op === "state") return { ok: true, data: await buildState() };

    if (op === "select") {
      var pick = findSession(a.id);
      selectedId = pick ? String(pick.id) : "";
      lastSig = "";
      return { ok: true, data: await buildState() };
    }

    if (op === "newSession") {
      if (typeof newAgentSession !== "function") return { ok: false, error: "unsupported" };
      var prevActive = "";
      try {
        prevActive = String((typeof S !== "undefined" && S.agentActiveId) || "");
      } catch (_) {}
      /* 新建会话跟随**当前选中的这条会话**（用户共识）：所属画布 + 项目文件夹都接它那一份 ——
         小窗里「＋」的语义是「接着我在看的这条干活」，不是「按主窗此刻的画布另起一条」。
         目录本身不另算，真源仍是主窗那套生效工作区（agentRunWorkspace）；
         选中会话解析不出目录时退回原来那套（按新会话所属画布冻结一次，再不行落默认目录）。 */
      var base = selectedId ? findSession(selectedId) : null;
      var st = newAgentSession();
      /* newAgentSession 会把主窗的选中项拨到新会话上 —— 小窗新建不该改变主窗正在看的东西，
         原样拨回去（会话本身已进列表，主窗切过去时还在）。 */
      try {
        if (typeof S !== "undefined" && prevActive) S.agentActiveId = prevActive;
      } catch (_) {}
      if (base && st) {
        var baseCanvas = String(base.canvasWfId || "");
        if (baseCanvas) st.canvasWfId = baseCanvas;
        var baseWs = "";
        try {
          if (typeof agentRunWorkspace === "function")
            baseWs = String(agentRunWorkspace(base) || "").trim();
        } catch (_) {}
        if (baseWs) {
          try {
            if (typeof agentSetSessionWorkspace === "function")
              await agentSetSessionWorkspace(st, baseWs);
            else st.workspace = baseWs;
          } catch (_) {
            st.workspace = baseWs;
          }
        } else {
          /* 没有目录可继承：清掉 newAgentSession 按主窗画布冻结的那份，按**新的所属画布**
             重新冻结一次（还是解析不出就留空，由运行期落默认目录） */
          st.workspace = "";
          try {
            if (typeof agentFreezeSessionWorkspace === "function") agentFreezeSessionWorkspace(st);
          } catch (_) {}
        }
      }
      selectedId = String((st && st.id) || "");
      try {
        if (typeof agentFlushSessionSaveQuiet === "function") await agentFlushSessionSaveQuiet();
      } catch (_) {}
      try {
        if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
      } catch (_) {}
      lastSig = "";
      return { ok: true, data: await buildState() };
    }

    if (op === "send") {
      var body = String(a.text || "").trim();
      if (!body) return { ok: false, error: "empty" };
      var target = findSession(a.sessionId);
      if (!target) return { ok: false, error: "missing" };
      if (typeof agentSessionSend !== "function") return { ok: false, error: "unsupported" };
      /* 小窗的两枚开关只作用于**这一轮**（共识 q3 / q7）：按轮覆写传给 agentSessionSend，
         **不写会话字段** —— 主窗那条会话的 grill / hotfix 设置一点不受影响。 */
      var sendOpts = { sessionId: target.id };
      if (typeof a.grill === "boolean") sendOpts.grillOverride = a.grill;
      if (typeof a.hotfix === "boolean") sendOpts.hotfixOverride = a.hotfix;
      /* 不 await 整轮：这一轮可能跑很久，小窗只要「已下发」的即时回执；
         忙的时候 agentSessionSend 自己会把它放进发送队列（与主界面同一条口径）。 */
      Promise.resolve()
        .then(function () {
          return agentSessionSend(body, sendOpts);
        })
        .catch(function () {});
      setTimeout(pushNow, 120);
      return { ok: true, data: { sessionId: String(target.id) } };
    }

    if (op === "stop") {
      var s2 = findSession(a.id);
      if (!s2) return { ok: false, error: "missing" };
      try {
        if (typeof stopSessionRuns === "function") stopSessionRuns(s2, true);
      } catch (_) {}
      /* 助手会话另有一条自己的运行键（S.assistRunning）：同一条助手会话才补一刀 */
      try {
        if (
          s2.assist &&
          typeof S !== "undefined" &&
          String(S.assistSessionId || "") === String(s2.id) &&
          typeof assistStop === "function"
        )
          assistStop();
      } catch (_) {}
      setTimeout(pushNow, 120);
      return { ok: true };
    }

    if (op === "goto") {
      var s3 = findSession(a.id);
      if (!s3) return { ok: false, error: "missing" };
      try {
        if (typeof agentSelectSession === "function") agentSelectSession(s3.id);
        else if (typeof S !== "undefined") S.agentActiveId = s3.id;
        if (typeof setView === "function") setView("agent");
        if (typeof renderAgentSession === "function") renderAgentSession();
        if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
      } catch (_) {}
      return { ok: true };
    }

    return { ok: false, error: "unknown_op" };
  }

  /* ── 接线 ──────────────────────────────────────────────────────────── */
  api.onMiniChatReq(function (msg) {
    var rid = msg && msg.rid;
    var op = String((msg && msg.op) || "");
    var args = (msg && msg.args) || {};
    Promise.resolve()
      .then(function () {
        return handle(op, args);
      })
      .catch(function (e) {
        return { ok: false, error: "exception", detail: String((e && e.message) || e) };
      })
      .then(function (out) {
        var r = out || { ok: false, error: "empty" };
        try {
          api.miniChatRes({
            rid: rid,
            ok: r.ok !== false,
            error: r.error || "",
            detail: r.detail || "",
            data: r.data || null,
          });
        } catch (_) {}
      });
  });

  api.onMiniChatVisibility(function (p) {
    setOpen(!!(p && p.open));
  });

  /* 左下角入口（状态栏话筒旁那枚按钮）：点一下 = 打开 / 聚焦那只唯一的小窗 */
  function wireEntry() {
    var btn = document.getElementById("btnMiniChat");
    if (!btn) return;
    btn.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      try {
        Promise.resolve(api.miniChatOpen()).catch(function () {});
      } catch (_) {}
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireEntry);
  else wireEntry();

  /* 主窗卸载 / 刷新：停掉推送循环（小窗那边的中继会按 main_not_ready 提示） */
  window.addEventListener("beforeunload", stopLoop);
})();
