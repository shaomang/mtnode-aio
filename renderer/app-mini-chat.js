/* app-mini-chat.js — 快捷会话小窗的页面逻辑（renderer/mini-chat.html 专用）。
 *
 * 这只窗件的用途只有一件事：**快速对 agent 下发指令**，不是观察 agent 行为。所以正文区
 * 只放「这一条会话的最后一条 AI 回复」+ 自己刚下发的那句灰气泡，不渲染思考、工具调用与历史。
 *
 * 数据与控制全部来自主窗口渲染层（见 renderer/app-mini-chat-host.js 的中继协议）：
 *   api.state() / select(id) / newSession() / send({sessionId,text}) / stop(id) /
 *   gotoSession(id)，以及 api.onPush(state) —— 主窗每一拍把变化推过来，本页面只负责画。
 * 本文件不猜任何业务口径：忙 / 排队 / 暂停都是主窗算好后给的字面状态。
 */
(function () {
  "use strict";

  var api = window.miniChat;
  var T = function (k, fallback) {
    var d = (api && api.__dict) || {};
    return d[k] || fallback || k;
  };

  var dict = {};
  var state = null;
  var sidebarOpen = false; /* 左栏默认不显示（需求） */
  var pendingSend = false;
  var scrollAtBottom = true;
  /* 输入框上方那两枚模式开关（本轮需求 · 共识 q3/q4/q5/q7）：
     整个小窗共用一份，缺省「不拷问需求 + 热修开」，两枚互斥；真源在主进程那份
     mini-chat.json（重启仍生效），本页只负责画与点。它们**只影响本窗发出的那一轮**，
     不读也不写会话的 grill / hotfix 字段。 */
  var modes = { grill: false, hotfix: true };

  function $(id) {
    return document.getElementById(id);
  }

  /* 词条：主进程用 I18n.t 现算好一整份下发（页面不做语言判断） */
  function applyDict(d) {
    dict = d && typeof d === "object" ? d : {};
    T = function (k, fallback) {
      return dict[k] || fallback || k;
    };
    document.title = T("title", "快捷会话");
    $("mcTitle").textContent = T("title", "快捷会话");
    $("mcListBtn").title = T("list", "会话列表");
    $("mcNewBtn").title = T("newSession", "新建会话");
    $("mcCloseBtn").title = T("close", "关闭");
    $("mcSideHead").textContent = T("sessions", "会话");
    $("mcGotoBtn").title = T("goto", "在主窗口打开该会话");
    $("mcStopBtn").title = T("stop", "停止");
    $("mcSendBtn").textContent = T("send", "发送");
    $("mcInput").placeholder = T("placeholder", "输入指令…（Enter 发送，Shift+Enter 换行）");
    $("mcModeGrill").textContent = T("grill", "拷问需求");
    $("mcModeHotfix").textContent = T("hotfix", "热修");
    /* 末尾那块「你的指令」小字（常显）：只在有自己那句话时随整块一起出现 */
    if ($("mcUserTag")) $("mcUserTag").textContent = T("yourMsg", "你的指令");
    paintModes();
  }

  function text(el, v) {
    el.textContent = v == null ? "" : String(v);
  }

  /* ── 项目文件夹（本轮需求 · 共识 q1/q2）─────────────────────────────────
     小窗很窄，所以只显示文件夹名（`E:\dev\tools\pipeline-console` → `pipeline-console`），
     完整路径与来源放 tooltip；解析不出目录时如实写「未设置目录」，绝不编造路径。 */
  function baseName(p) {
    var s = String(p || "").replace(/[\\/]+$/, "");
    if (!s) return "";
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function wsName(p) {
    var s = String(p || "");
    return baseName(s) || s;
  }
  function wsTitle(p, src) {
    if (!p) return "";
    var bits = [T("wsLabel", "项目文件夹") + "：" + String(p)];
    if (src) bits.push(T("wsFrom", "来源：") + String(src));
    return bits.join("\n");
  }

  /* ── 两枚模式开关（互斥 · 整窗共用一份记忆）────────────────────────────── */
  function paintModes() {
    var g = $("mcModeGrill");
    var h = $("mcModeHotfix");
    if (!g || !h) return;
    g.classList.toggle("on", !!modes.grill);
    h.classList.toggle("on", !!modes.hotfix);
    g.setAttribute("aria-pressed", modes.grill ? "true" : "false");
    h.setAttribute("aria-pressed", modes.hotfix ? "true" : "false");
    g.title = T("grillTip", "拷问需求：开启后每轮先问清再动手（与「热修」互斥）");
    h.title = T(
      "hotfixTip",
      "热修：最快路径 —— 只在真有歧义时问一句，不写文档、不跑 smoke test（与「拷问需求」互斥）",
    );
  }
  /* 点一枚 = 打开它并关掉另一枚（共识 q5），随即落盘（共识 q4） */
  function setMode(key, on) {
    modes[key] = !!on;
    if (on) {
      if (key === "grill") modes.hotfix = false;
      else modes.grill = false;
    }
    paintModes();
    try {
      if (api && typeof api.setModes === "function")
        Promise.resolve(api.setModes({ grill: !!modes.grill, hotfix: !!modes.hotfix })).catch(
          function () {},
        );
    } catch (_) {}
  }

  /* 回复正文 → HTML：**与主窗口同一份内核**（renderer/md-render.js 的 window.MTRender，
   * app.js 的 renderMarkdown 也是它的包装）。以前这里是 textContent 直接塞原文，用户看到的
   * 就是「一坨没渲染的 markdown」，所以正文一律走这条管线：
   *   · 先转义再解析 → 正文里的 HTML 标签进不来；
   *   · 链接只放行 http(s)/mailto，点了交给系统浏览器（见 bind() 里的委托），不给窗口导航；
   *   · 内核缺席（页面脚本没加载全）时返回空串，调用方退回纯文本，绝不白屏。 */
  function replyHtml(md) {
    var R = window.MTRender;
    if (!R || typeof R.toHtml !== "function") return "";
    try {
      return String(R.toHtml(md) || "");
    } catch (_) {
      return "";
    }
  }

  function paintPill(sel) {
    var pill = $("mcPill");
    var stop = $("mcStopBtn");
    var paused = !!(sel && sel.paused);
    var busy = !!(sel && sel.busy);
    var queued = !!(sel && sel.queued);
    var label = "";
    var cls = "mc-pill";
    if (paused) {
      label = T("paused", "已暂停");
      cls += " is-paused";
    } else if (busy) {
      label = T("running", "运行中");
    } else if (queued) {
      label = T("queued", "排队中");
      cls += " is-queued";
    }
    if (label) {
      pill.textContent = label;
      pill.className = cls;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
    /* 停止只在真有活在跑（或暂停待续）时露出来：空闲时按它什么也不会发生 */
    stop.hidden = !(busy || queued || paused);
  }

  /* ── 左栏：按项目文件夹分组（与主窗口会话界面同口径）──────────────────────
     组标题 = `📁 文件夹名 · 条数`，会话挂在下面；行内不再重复第二行目录小字（小窗窄，
     同一条目录说两遍只会挤掉标题）。分组键与显示名都复用上面那套「只取内层文件夹名」的口径，
     没有目录的会话归入「未设置目录」组，绝不编造路径。
     组顺序 = 组内最新会话的时间倒序，组内也按新→旧（state.sessions 已由主窗按时间排好，
     这里保持到达顺序即可，不重排 —— 免得「点一下会话就跳位」）。 */
  function renderList() {
    var list = $("mcList");
    list.innerHTML = "";
    var sessions = (state && state.sessions) || [];
    if (!sessions.length) {
      var none = document.createElement("div");
      none.className = "mc-empty";
      text(none, T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"));
      list.appendChild(none);
      return;
    }
    var selId = String((state && state.selectedId) || "");
    var groups = [];
    var byKey = {};
    sessions.forEach(function (s) {
      var wsPath = String((s && s.ws) || "");
      var key = wsPath ? wsName(wsPath) : "";
      var gid = key || "\u0000none";
      if (!byKey[gid]) {
        byKey[gid] = { key: key, path: wsPath, src: (s && s.wsSrc) || "", items: [] };
        groups.push(byKey[gid]);
      }
      byKey[gid].items.push(s);
    });
    groups.forEach(function (g) {
      var gh = document.createElement("div");
      gh.className = "mc-group" + (g.path ? "" : " is-none");
      text(gh, "📁 " + (g.path ? g.key : T("noWs", "未设置目录")) + " · " + g.items.length);
      gh.title = g.path
        ? wsTitle(g.path, g.src)
        : T("noWsHint", "这些会话还没解析出项目文件夹（主窗口里给它设一个工作目录即可）");
      list.appendChild(gh);
      g.items.forEach(function (s) {
        var row = document.createElement("div");
        row.className = "mc-item" + (String(s.id) === selId ? " is-active" : "");
        row.setAttribute("role", "listitem");
        /* 行悬停说明：标题 + 这条会话自己的目录（组标题已写文件夹名，这里给全路径与来源） */
        var wsPath = String((s && s.ws) || "");
        row.title = [s.title || "", wsPath ? wsTitle(wsPath, s.wsSrc) : T("noWs", "未设置目录")]
          .filter(Boolean)
          .join("\n");
        var dot = document.createElement("i");
        dot.className = "mc-dot";
        dot.hidden = !s.busy;
        row.appendChild(dot);
        var nm = document.createElement("span");
        nm.className = "mc-item-name";
        text(nm, s.title || T("newSession", "新会话"));
        row.appendChild(nm);
        if (s.badge) {
          var b = document.createElement("span");
          b.className = "mc-badge";
          text(b, s.badge);
          row.appendChild(b);
        }
        row.onclick = function () {
          selectSession(s.id);
        };
        list.appendChild(row);
      });
    });
  }

  /* forceBottom：发送后第一次回显时用 —— 不管用户之前滚到哪，都把视口钉到最末，
     保证「自己刚下发的那句」立刻可见（它现在是整段最后一块，见 mini-chat.html）。 */
  function renderBody(forceBottom) {
    var sel = state && state.selected;
    text($("mcSessName"), sel ? sel.title || T("newSession", "新会话") : "—");
    /* 顶部会话栏下那一行小字：这条会话真正工作的目录（共识 q1） */
    var wsRow = $("mcWsRow");
    if (wsRow) {
      var selWs = sel && sel.ws ? String(sel.ws) : "";
      if (sel) {
        wsRow.hidden = false;
        wsRow.className = "mc-wsrow" + (selWs ? "" : " is-none");
        text(wsRow, "📁 " + (selWs ? wsName(selWs) : T("noWs", "未设置目录")));
        wsRow.title = selWs
          ? wsTitle(selWs, sel.wsSrc)
          : T("noWsHint", "这条会话还没解析出项目文件夹（主窗口里给它设一个工作目录即可）");
      } else {
        wsRow.hidden = true;
        wsRow.textContent = "";
        wsRow.title = "";
      }
    }
    paintPill(sel);
    var replyEl = $("mcReply");
    var userEl = $("mcUser");
    /* 自己那句连同「你的指令」小字一起藏在同一块里：常显（用户共识 q5），
       位置在 AI 回复之后 = 整段最末（用户共识 q1/q3）。 */
    var userTurnEl = $("mcUserTurn") || userEl;
    var emptyEl = $("mcEmpty");
    var reply = sel && sel.lastReply ? String(sel.lastReply) : "";
    var user = sel && sel.lastUser ? String(sel.lastUser) : "";
    if (user) {
      userTurnEl.hidden = false;
      text(userEl, user);
    } else {
      userTurnEl.hidden = true;
      userEl.textContent = "";
    }
    if (reply) {
      /* 标题 / 列表 / 代码块 / 表格 / 加粗都按 Markdown 渲染（replyHtml 已经做过 HTML 转义）。
         自己下发的那句仍是灰色纯文本气泡（见上），用户写什么就显示什么。 */
      var html = replyHtml(reply);
      if (html) replyEl.innerHTML = html;
      else text(replyEl, reply);
      emptyEl.hidden = true;
    } else {
      replyEl.textContent = "";
      emptyEl.hidden = false;
      text(
        emptyEl,
        sel
          ? sel.busy
            ? T("waiting", "正在跑，跑完这里会出现它的回复…")
            : T("emptyNoReply", "这条会话还没有回复")
          : T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"),
      );
    }
    var scroll = $("mcScroll");
    if (forceBottom) scrollAtBottom = true;
    if (scrollAtBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function render(forceBottom) {
    renderList();
    renderBody(forceBottom);
    $("mcSide").hidden = !sidebarOpen;
    $("mcListBtn").setAttribute("aria-pressed", sidebarOpen ? "true" : "false");
  }

  function note(msg, warn) {
    var el = $("mcNote");
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "mc-note" + (warn ? " is-warn" : "");
    text(el, msg);
  }

  function errText(r) {
    var why = (r && r.error) || "";
    if (why === "main_not_ready") return T("mainNotReady", "主窗口不可用，先在主窗口打开一次");
    if (why === "timeout") return T("timeout", "主窗口没有响应，稍后再试");
    if (why === "missing") return T("sessionMissing", "这条会话已不存在");
    if (why === "empty") return T("emptyText", "先写一句指令");
    return T("failed", "操作失败");
  }

  function applyState(r) {
    if (!r || r.ok === false || !r.data) {
      note(errText(r), true);
      return false;
    }
    state = r.data;
    scrollAtBottom = true;
    render();
    note("");
    return true;
  }

  function selectSession(id) {
    if (!api) return;
    api
      .select(id)
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  function newSession() {
    if (!api) return;
    api
      .newSession()
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  function send() {
    if (!api || pendingSend) return;
    var input = $("mcInput");
    var body = String(input.value || "").trim();
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!body) {
      note(T("emptyText", "先写一句指令"), true);
      input.focus();
      return;
    }
    if (!sid) {
      note(T("emptyNoSession", "还没有会话，点右上角 ＋ 新建一条"), true);
      return;
    }
    pendingSend = true;
    $("mcSendBtn").disabled = true;
    api
      .send({
        sessionId: sid,
        text: body,
        /* 这一轮的模式（共识 q3/q7）：只随这一轮下发，不改会话字段 */
        grill: !!modes.grill,
        hotfix: !!modes.hotfix,
      })
      .then(function (r) {
        if (!r || r.ok === false) {
          note(errText(r), true);
          return;
        }
        input.value = "";
        /* 乐观回显：主窗那一拍推送回来之前，先把用户这句显示出来（灰气泡）。
           它排在 AI 回复之后 = 整段最末，所以强制滚到底（用户共识 q1/q2）。 */
        if (state && state.selected) {
          state.selected.lastUser = body;
          renderBody(true);
        }
        note(T("sent", "已下发"), false);
        setTimeout(function () {
          note("");
        }, 1600);
      })
      .catch(function () {
        note(T("failed", "操作失败"), true);
      })
      .then(function () {
        pendingSend = false;
        $("mcSendBtn").disabled = false;
        input.focus();
      });
  }

  function stop() {
    if (!api) return;
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!sid) return;
    api
      .stop(sid)
      .then(function (r) {
        if (!r || r.ok === false) note(errText(r), true);
      })
      .catch(function () {});
  }

  function gotoSession() {
    if (!api) return;
    var sid = state && state.selectedId ? String(state.selectedId) : "";
    if (!sid) return;
    api.gotoSession(sid).catch(function () {});
  }

  function bind() {
    $("mcListBtn").onclick = function () {
      sidebarOpen = !sidebarOpen;
      render();
    };
    $("mcNewBtn").onclick = newSession;
    $("mcCloseBtn").onclick = function () {
      if (api) api.close();
    };
    $("mcSendBtn").onclick = send;
    $("mcStopBtn").onclick = stop;
    $("mcGotoBtn").onclick = gotoSession;
    /* 两枚模式开关：点一枚 = 打开它并关掉另一枚（互斥），随即落盘 */
    if ($("mcModeGrill"))
      $("mcModeGrill").onclick = function () {
        setMode("grill", !modes.grill);
      };
    if ($("mcModeHotfix"))
      $("mcModeHotfix").onclick = function () {
        setMode("hotfix", !modes.hotfix);
      };
    var input = $("mcInput");
    input.addEventListener("keydown", function (ev) {
      /* 中文输入法组字中的 Enter 属于选词，不是发送 */
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });
    /* 正文里的链接（Markdown 的 [文字](https://…)）：小窗不给导航离开本页 ——
       一律拦下，http(s)/mailto 交系统默认程序打开，其余（相对路径 / file:）点了不动。 */
    var replyEl = $("mcReply");
    if (replyEl) {
      replyEl.addEventListener("click", function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
        if (!a) return;
        ev.preventDefault();
        var href = String(a.getAttribute("href") || "");
        if (!/^(https?:|mailto:)/i.test(href)) return;
        try {
          if (api && typeof api.openExternal === "function") api.openExternal(href);
        } catch (_) {}
      });
    }
    /* Esc = 关窗（与 ✕ 同一语义：销毁窗口，不做「收起」） */
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (api) api.close();
      }
    });
    var scroll = $("mcScroll");
    scroll.addEventListener("scroll", function () {
      scrollAtBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
    });
    input.focus();
  }

  function boot() {
    if (!api) {
      /* 桥没起来（极少见：preload 缺失）—— 至少不白屏 */
      text($("mcEmpty"), "preload 桥未就绪");
      return;
    }
    bind();
    api.i18n().then(function (r) {
      applyDict(r && r.dict);
      render();
    });
    /* 两枚模式开关的初值（缺省不拷问 + 热修开；用户改过的从主进程那份记忆读回来） */
    try {
      if (typeof api.modes === "function")
        Promise.resolve(api.modes())
          .then(function (m) {
            if (!m || typeof m !== "object") return;
            if (typeof m.grill === "boolean") modes.grill = m.grill;
            if (typeof m.hotfix === "boolean") modes.hotfix = m.hotfix;
            /* 老存档两枚都为真时按热修优先归一（与主进程写入口径一致） */
            if (modes.grill && modes.hotfix) modes.grill = false;
            paintModes();
          })
          .catch(function () {});
    } catch (_) {}
    api.hotkey().then(function (r) {
      if (r && r.ok === false)
        note(T("hotkeyFail", "F1 被其它程序占用，用左下角入口按钮打开"), true);
    });
    api.onPush(function (payload) {
      if (!payload || payload.type !== "state" || !payload.data) return;
      var stick = scrollAtBottom;
      state = payload.data;
      scrollAtBottom = stick;
      render();
    });
    api
      .state()
      .then(applyState)
      .catch(function () {
        note(T("failed", "操作失败"), true);
      });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
