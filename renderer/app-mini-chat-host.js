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
 *   newSession    {ws?}                     新建一条（不带 ws 接当前选中会话；带 ws 就落这一组文件夹）
 *   send          {sessionId, text}        走 agentSessionSend（忙则自动进发送队列，与主界面同源）
 *   attachImage   {sessionId, base64, ext} 粘贴的截图落成真文件（会话工作区 .mtnode-input/），回绝对路径
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
  /* 上一次用的那条会话（本次修复）：盘上记着（主进程 mini-chat.json 的 lastSessionId），
     关掉 MTNode 再开、重新唤出小窗，回到的还是这一条。
     lastLoaded 之前**不写盘** —— 读回来之前别拿「主窗此刻选中的」把它盖掉。 */
  var lastId = "";
  var lastLoaded = false;
  var miniOpen = false;
  var timer = null;
  var lastSig = "";
  /* 状态快照的单调序号：buildState 一开跑就取号（不是回来时取），
     小窗据此丢掉「比手上这份还旧」的迟到快照（见 app-mini-chat.js 的 acceptState）。 */
  var stateRev = 0;

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

  /* 选哪一条：① 小窗这次已经选过的 → ② 盘上记的「上一次用的」→ ③ 主窗当前选中的 → ④ 列表第一条。
     ②那一条可能已经掉出「最近 20 条」，那就把它补进列表末尾 —— 否则它永远选不回来，
     用户看到的就是「每次开小窗都跳回别的会话」。 */
  function pickId(top) {
    var want = String(selectedId || lastId || "");
    if (want) {
      var hit = findSession(want);
      if (hit && !hit.archived) {
        var listed = top.some(function (s) {
          return String(s.id) === want;
        });
        if (!listed) top.push(hit);
        return String(hit.id);
      }
    }
    var act = "";
    try {
      act = String((typeof S !== "undefined" && S.agentActiveId) || "");
    } catch (_) {}
    if (act && top.some(function (s) { return String(s.id) === act; })) return act;
    return top.length ? String(top[0].id) : "";
  }

  /* 记住小窗这一轮选中的会话（换会话 / 新建 / 删除后都会走到这里）。
     只写 id，内容一概不碰；force = 用户自己点的，读盘还没回来也照写。 */
  function rememberSession(id, force) {
    var sid = String(id || "");
    /* 空 id 只在用户主动那一路（删掉最后一条、点了条不存在的）才落盘：
       会话列表还没装载完时的空快照不该把「上一次用的那条」抹掉。 */
    if (!sid && !force) return;
    if (sid === lastId) return;
    if (!lastLoaded && !force) return;
    lastId = sid;
    try {
      if (typeof api.miniChatSetLastSession === "function")
        Promise.resolve(api.miniChatSetLastSession(sid)).catch(function () {});
    } catch (_) {}
  }

  /* 开机读回上一次用的那条：先落 selectedId（用户此刻已经点过别的就不动），再解禁写盘 */
  function loadLastSession() {
    try {
      if (typeof api.miniChatLastSession !== "function") {
        lastLoaded = true;
        return;
      }
      Promise.resolve(api.miniChatLastSession())
        .then(
          function (r) {
            var id = r && r.id != null ? String(r.id) : "";
            if (id) {
              lastId = id;
              if (!selectedId) selectedId = id;
            }
            lastLoaded = true;
            lastSig = ""; /* 读回来后下一拍按它重选、重推 */
          },
          function () {
            lastLoaded = true;
          },
        )
        .catch(function () {
          lastLoaded = true;
        });
    } catch (_) {
      lastLoaded = true;
    }
  }

  /* 会话正文里最后一条非空消息的角色（"" = 一条都没有）。
     小窗只画「最后一句用户话 + 最后一条回复」这一对，所以只有**这一对真成对**时
     才把回复下发：最后一条非空消息不是助手（刚下发 / 已排队 / 提问已回答），说明
     这一轮还没回复，此时把上一条回复一起递下去，窗口就成了「新指令配旧回答」——
     读起来正是「agent 没看见我写的内容、答非所问」。 */
  function lastNonEmptyRole(st) {
    var ms = (st && Array.isArray(st.messages) && st.messages) || [];
    for (var i = ms.length - 1; i >= 0; i--) {
      var m = ms[i];
      if (!m) continue;
      if (!String(m.content == null ? "" : m.content).trim()) continue;
      return String(m.role || "");
    }
    return "";
  }

  /** 组一份小窗要的状态（只含它要画的东西） */
  async function buildState() {
    /* 取号在对齐任何 await 之前：先起跑的 buildState 必然拿到更小的号 */
    var rev = ++stateRev;
    var top = topSessions();
    var sid = pickId(top);
    selectedId = sid;
    /* 落在哪一条就记下来（下次开窗 / 重启后还落这一条）；只写一个 id，不写会话内容 */
    rememberSession(sid, false);
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
      /* 排队中的那句还没进正文（在会话的 outbox 里，等前面这一轮跑完才发）：
         不把它当「最后一句用户话」，小窗就会在自己发出去之后把刚写的那句抹掉，
         再配一条上轮的回复 —— 同样读成「agent 没收到我说的」。排队条目永远比起
         正文里的更晚，所以有就直接用它。 */
      var queuedText = "";
      try {
        var ob = Array.isArray(st.outbox) ? st.outbox : [];
        for (var qi = ob.length - 1; qi >= 0; qi--) {
          var qt = String((ob[qi] && ob[qi].text) || "").trim();
          if (qt) {
            queuedText = qt;
            break;
          }
        }
      } catch (_) {}
      selected = {
        id: String(st.id),
        title: String(st.title || t("新会话")),
        busy: busyOf(st),
        queued: queuedOf(st),
        paused: !!st.paused,
        ws: wsel.ws,
        wsSrc: wsel.wsSrc,
        lastReply:
          lastNonEmptyRole(st) === "assistant" ? lastOfRole(st, "assistant", REPLY_MAX) : "",
        lastUser: queuedText || lastOfRole(st, "user", 4000),
      };
    }
    return { rev: rev, sessions: sessions, selectedId: sid, selected: selected };
  }

  function pushNow() {
    if (!miniOpen) return;
    Promise.resolve()
      .then(buildState)
      .then(function (data) {
        var sig = "";
        try {
          /* 去重只看内容：rev 每拍都变，带上它等于「永远有变化」，800ms 一拍就白推了 */
          var forSig = Object.assign({}, data);
          delete forSig.rev;
          sig = JSON.stringify(forSig);
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

  /* 小窗开 / 关的唯一状态入口（主进程的 minichat:visibility 与启动自愈都走这里）。
     open 不只是「起停推送循环」：状态栏入口 #btnMiniChat 也要跟着点亮 / 熄灭 ——
     与 DeepSeek 入口、语音播报同一套「亮着的开关」（css/layout.css 的 .sb-minichat.is-open）。
     按钮可能还没解析出来（DOMContentLoaded 之前的 visibility 推送），getElementById 现取即可。 */
  function setOpen(open) {
    miniOpen = !!open;
    if (miniOpen) startLoop();
    else stopLoop();
    try {
      var btn = document.getElementById("btnMiniChat");
      if (btn) {
        btn.classList.toggle("is-open", miniOpen);
        btn.setAttribute("aria-pressed", miniOpen ? "true" : "false");
      }
    } catch (_) {}
  }

  /* ── 各 op 的实现 ──────────────────────────────────────────────────── */
  function findSession(id) {
    var sid = String(id || "");
    if (!sid) return null;
    var hit = sessionsArr().filter(function (s) { return String(s && s.id) === sid; })[0];
    return hit || null;
  }

  /* 粘贴截图的落盘目录：真源是主窗那套生效工作区（agentRunWorkspace），小窗不另算一套 */
  function attachWsOf(st) {
    return function () {
      try {
        return typeof agentRunWorkspace === "function"
          ? String(agentRunWorkspace(st) || "")
          : "";
      } catch (_) {
        return "";
      }
    };
  }
  /* 共享落盘函数缺席（脚本加载顺序被打断的沙箱）时的兜底：同样的目录口径，
     只是少了「无引用回收」那层判据 —— 绝不改写到别处，也绝不写坏字节。 */
  async function attachWriteFallback(picked, wsGetter) {
    var a2 = typeof window !== "undefined" ? window.api : null;
    if (!a2 || typeof a2.fileWriteBytes !== "function") return null;
    if (typeof joinPath !== "function") return null;
    var dir = "";
    try {
      var ws = String((wsGetter && wsGetter()) || "").trim();
      if (ws) dir = joinPath(ws, ".mtnode-input");
    } catch (_) {}
    if (!dir) {
      try {
        var r = await a2.dataGetRoot();
        if (r && r.ok && r.path) dir = joinPath(String(r.path), "chat-input");
      } catch (_) {}
    }
    if (!dir) return null;
    var ext = String((picked && picked.ext) || "png").replace(/^\./, "") || "png";
    var dest = joinPath(dir, "paste-" + Date.now().toString(36) + "." + ext);
    try {
      var bin = atob(String((picked && picked.base64) || ""));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var w = await a2.fileWriteBytes(dest, bytes);
      if (w && w.ok === false) return null;
    } catch (_) {
      return null;
    }
    return { path: dest, alt: t("截图") };
  }

  async function handle(op, args) {
    var a = args || {};
    if (op === "state") return { ok: true, data: await buildState() };

    if (op === "select") {
      var pick = findSession(a.id);
      selectedId = pick ? String(pick.id) : "";
      rememberSession(selectedId, true);
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
      /* 目标文件夹（组内「＋」）：小窗左栏某一组标题右边的 ＋ = 就**在这一组**里新建一条，
         不管此刻选中的是别组的哪条会话；空串 = 沿用上面那套（接当前选中会话的目录）。 */
      var wantWs = String((a && a.ws) || "").trim();
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
      /* 组内「＋」钉的目标文件夹：盖掉上面继承来的那一份（用户共识 q2 —— 点哪组就落哪组） */
      if (st && wantWs) {
        try {
          if (typeof agentSetSessionWorkspace === "function")
            await agentSetSessionWorkspace(st, wantWs);
          else st.workspace = wantWs;
        } catch (_) {
          st.workspace = wantWs;
        }
      }
      selectedId = String((st && st.id) || "");
      rememberSession(selectedId, true);
      try {
        if (typeof agentFlushSessionSaveQuiet === "function") await agentFlushSessionSaveQuiet();
      } catch (_) {}
      try {
        if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
      } catch (_) {}
      lastSig = "";
      return { ok: true, data: await buildState() };
    }

    /* ── 粘贴截图（本轮需求）：落盘口径与主窗输入框完全同源 ──────────────────
       真源是 app-assist.js 的 chatImgWriteBase64：会话工作区 .mtnode-input/paste-<36进制>.<ext>，
       没有工作目录退回数据目录 chat-input/（命名与「无引用回收」的 isChatInputImage 判据同源）。
       小窗只递过来「一只图」（base64），落哪儿、叫什么由这里算 —— 它不猜路径。 */
    if (op === "attachImage") {
      var targetImg = findSession(a.sessionId);
      if (!targetImg) return { ok: false, error: "missing" };
      var b64 = String(a.base64 || "").replace(/^data:[^,]*,/, "");
      if (!b64) return { ok: false, error: "empty" };
      var extImg = String(a.ext || "png").replace(/^\./, "").toLowerCase() || "png";
      var picked = { base64: b64, ext: extImg, name: "" };
      var wsGetter = attachWsOf(targetImg);
      var saved = null;
      try {
        if (typeof chatImgWriteBase64 === "function")
          saved = await chatImgWriteBase64(picked, wsGetter);
      } catch (_) {
        saved = null;
      }
      if (!saved || !saved.path) {
        try {
          saved = await attachWriteFallback(picked, wsGetter);
        } catch (_) {
          saved = null;
        }
      }
      if (!saved || !saved.path) return { ok: false, error: "write_failed" };
      return { ok: true, data: { path: String(saved.path), alt: String(saved.alt || "") } };
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

    if (op === "delete") {
      /* 删除会话（本轮需求）：交给主窗那条真删内核 deleteAgentSession ——
         摘节点关联 → 从列表摘掉 → 点名删会话文件 + 索引条目 → 重绘，盘上不留。
         小窗只递 id，磁盘口径不在这里另算一套。 */
      var s5 = findSession(a.id);
      if (!s5) return { ok: false, error: "missing" };
      if (typeof deleteAgentSession !== "function") return { ok: false, error: "unsupported" };
      try {
        await deleteAgentSession(String(s5.id));
      } catch (e) {
        return { ok: false, error: "exception", detail: String((e && e.message) || e) };
      }
      if (String(selectedId) === String(s5.id)) selectedId = "";
      rememberSession(selectedId, true);
      lastSig = "";
      return { ok: true, data: await buildState() };
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

  /* 上一次用的会话先读回来（本次修复）：小窗一开就落在这一条上，关掉 MTNode 再开也一样。
     放在推送循环自愈之前 —— 读回来那一拍正好把 selectedId 拨对。 */
  loadLastSession();

  /* 推送循环的「自愈」入口（本次修复）：主窗渲染层重载后，上面那个 visibility 事件
     不会再送一遍 —— miniOpen 停在 false，推送循环永远起不来，小窗就停在旧内容上：
     用户在小窗里发了新指令、agent 也跑完了，窗口里却一直等不到那条回复。
     初始化时主动问主进程「小窗现在开着吗」：开着就把循环接回来（问完再推一拍）。 */
  try {
    if (typeof api.miniChatIsOpen === "function")
      Promise.resolve(api.miniChatIsOpen())
        .then(function (r) {
          if (r && r.open) setOpen(true);
        })
        .catch(function () {});
  } catch (_) {}

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
