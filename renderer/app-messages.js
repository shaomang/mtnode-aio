/* 消息（打赏 / 评论 / 回复三类日志，云端保存）—— 自包含模块，挂 window.MtMessages
 *
 * 一、它是什么
 *   顶栏「消息」入口（.tb-end 里紧贴「应用」左边）+ 一只消息窗：把**别人对你做的事**
 *   按三类列出来 —— 打赏（tip）/ 评论（comment）/ 回复（reply）。日志存在云端，
 *   本机不落一份（换机器 / 重装都还在）。
 *
 * 二、接口契约（真源：云端 /api/notifications*；字段名以服务端为准，客户端不改名）
 *   · GET  /api/notifications?limit=20&cursor=<ms>
 *        → { ok, unread, items:[{ id, kind:"tip"|"comment"|"reply", at, read,
 *                                 title, text, targetKind, targetId,
 *                                 actor:{ id, username, nickname } }] }
 *   · GET  /api/notifications/unread   → { ok, unread }（60 秒轮询只用它）
 *   · POST /api/notifications/read     { ids:[…] } → { ok, unread }
 *        **ids 空数组 / 不传 = 全部已读**，所以标记已读时绝不能误发空数组。
 *   · POST /api/notifications/clear    → { ok, unread:0 }
 *   四个接口都要登录，未登录 401。请求统一走 window.api.storeRequest（主进程自动带
 *   Bearer，渲染层不接触 token）——与 app-comments.js 同一套 api() 封装。
 *   cursor = 上一页最后一条的 at（毫秒）。
 *
 * 三、按钮的三态（置灰与否的唯一依据 = paintEntry）
 *   · 未登录（或未读数接口回 401）→ 置灰，title「登录后可看消息」
 *   · 未读数接口不可用（网络 / 5xx）→ 置灰，title「消息服务暂时不可用，稍后重试」
 *   · 已登录且一条消息都没有（未读 0 且列表为空）→ 置灰，title「暂无消息」
 *   · 有消息（含已读但没清空）→ 可点；右上角角标 = 未读数（>99 显示 99+，0 时隐藏）
 *
 * 四、窗口与 persistent
 *   openOverlay(I18n.t("消息"), { persistent: true, min: true })（宿主 = 画布）。
 *   **persistent 是全应用铁律**（AGENTS.md「协作约定」）：本文件不挂任何点蒙层 /
 *   点外部的关闭监听，关闭只走窗内「关闭」按钮、标题栏 ✕、Esc（Esc 只在这只窗
 *   仍是 #overlay 当前内容时生效，最小化停放 / 被别的窗顶掉都不认）。
 *   打开即把**已展示的条目**逐条标记已读（POST read 带这些 id），角标随之归零；
 *   分页由底部「加载更多」按 cursor 拉下一页。
 *
 * 五、跳转（只走既有入口，不假装跳转）
 *   · 应用（targetKind=app）→ window.openAppsDetail(id)（拉不到退回应用中心目录页）
 *   · 工坊条目（template / skill）→ 先 GET /api/templates|skills/<id> 取条目，
 *     再 openTplItemDetail(item)（二级浮层，不会冲掉本窗）；条目拉不到退回创意工坊
 *   · 讨论区（forum_topic / forum_reply）→ window.api.forumOpen() 打开讨论区窗口，
 *     并**明说**暂不支持定位到具体那条话题（做不到就如实讲，不弹假动作）
 *   · 其它 → 一句「这一类消息暂不支持跳转」，只显示
 *
 * 六、依赖
 *   window.api.storeRequest、app.js 的 openOverlay / closeOverlay / toast / confirmDialog、
 *   window.MTNodeAuth（登录态唯一来源）、optional I18n。初始化失败只吞在内部，不抛到控制台外。
 */
(function () {
  "use strict";

  /* ── 小工具（与 app-tips.js / app-comments.js 同一套写法） ─────────── */

  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  /* toast 是 app.js 顶层的全局函数；模块被单独加载（单测 / 预览页）时不该炸 */
  function toastSafe(msg, kind) {
    if (typeof toast === "function") toast(msg, kind);
  }
  function api(method, path, json) {
    if (!window.api || typeof window.api.storeRequest !== "function") {
      return Promise.resolve({ ok: false, status: 0, error: T("账户服务未就绪") });
    }
    return window.api.storeRequest({ method: method, path: path, json: json });
  }
  function errText(r) {
    if (!r) return T("网络请求失败");
    if (r.data && r.data.error) return r.data.error;
    if (r.error) return r.error;
    return "HTTP " + (r.status || "");
  }
  function signedIn() {
    var A = window.MTNodeAuth;
    if (!A || typeof A.state !== "function") return false;
    var s = A.state();
    return !!(s && s.signedIn && s.user);
  }
  function openLogin() {
    if (window.MTNodeAuth && typeof window.MTNodeAuth.open === "function") window.MTNodeAuth.open();
    else toastSafe(T("登录服务未就绪"), "err");
  }
  function tsText(ms) {
    if (!ms) return "—";
    var d = new Date(Number(ms));
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  /* 消息类型（服务端 kind 三值）→ 界面标签。**用字面量调用 T()**（键必须能被 i18n 静态
     登记，也是 test/smoke-messages.js 收集词条的口径）。 */
  function kindText(k) {
    if (k === "tip") return T("打赏");
    if (k === "comment") return T("评论");
    if (k === "reply") return T("回复");
    return T("消息");
  }
  function kindCls(k) {
    if (k === "tip") return "tip";
    if (k === "comment") return "comment";
    if (k === "reply") return "reply";
    return "other";
  }
  /* 消息对象（targetKind）→ 界面标签：与 app-tips.js / app-comments.js 的对象类型同源 */
  function targetText(k) {
    if (k === "template") return T("模板");
    if (k === "skill") return T("Skill");
    if (k === "app") return T("应用");
    if (k === "forum_topic") return T("讨论区话题");
    if (k === "forum_reply") return T("讨论区回复");
    return "";
  }
  function actorName(it) {
    var a = (it && it.actor) || {};
    return a.nickname || a.username || T("匿名用户");
  }

  /* ── 接口路径与轮询口径（改动这里 = 改契约引用，别在别处另写一份字符串） ── */

  var API_LIST = "/api/notifications";
  var API_UNREAD = "/api/notifications/unread";
  var API_READ = "/api/notifications/read";
  var API_CLEAR = "/api/notifications/clear";
  var PAGE_SIZE = 20; /* 与契约默认 limit=20 一致 */
  var POLL_MS = 60 * 1000; /* 未读数轮询：60 秒一次 */

  function listPath(limit, cursorMs) {
    var q = API_LIST + "?limit=" + encodeURIComponent(String(limit || PAGE_SIZE));
    if (cursorMs) q += "&cursor=" + encodeURIComponent(String(cursorMs));
    return q;
  }
  function cursorOf(items) {
    var last = (items || [])[items.length - 1];
    var ms = Number(last && last.at);
    return isFinite(ms) && ms > 0 ? ms : 0;
  }

  /* ── 状态（按钮三态 + 列表缓存的唯一真源） ───────────────────
     unread    = 服务端回的未读数（角标）
     hasItems  = **有消息**（含已读但没清空）→ 按钮可点的依据：未读数全为 0 时靠列表判定
     available = 未读数接口可用（false → 置灰）
     seeded    = 是否已用列表判定过 hasItems（判定过就不再反复拉列表） */
  var ST = {
    unread: 0,
    hasItems: false,
    available: true,
    seeded: false,
    items: [],
    cursorMs: 0,
    hasMore: false,
    busy: false,
  };
  var _timer = null; /* 全局只有一个定时器（ensurePoll 每次先清再建） */
  var _offAuth = null;

  function resetState() {
    ST.unread = 0;
    ST.hasItems = false;
    ST.available = true;
    ST.seeded = false;
    ST.items = [];
    ST.cursorMs = 0;
    ST.hasMore = false;
  }

  /* ── 顶栏入口：三态 + 未读角标 ─────────────────────────────── */

  function btnEl() {
    return document.getElementById("btnMessages");
  }

  function paintEntry() {
    var btn = btnEl();
    if (!btn) return;
    var on = signedIn();
    var usable = !on || !ST.available ? false : ST.hasItems;
    var reason = !on
      ? T("登录后可看消息")
      : !ST.available
        ? T("消息服务暂时不可用，稍后重试")
        : !ST.hasItems
          ? T("暂无消息")
          : T("消息：打赏 / 评论 / 回复");
    btn.disabled = !usable;
    btn.title = reason;
    btn.setAttribute("aria-label", reason);
    btn.classList.toggle("unread", usable && ST.unread > 0);
    var badge = document.getElementById("btnMessagesBadge");
    if (badge) {
      var n = Number(ST.unread) || 0;
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.hidden = !on || n <= 0;
    }
  }

  /* 拉一页列表并并进缓存（reset=true = 从第一页重新开始） */
  function absorbPage(d, reset) {
    var items = (d && d.items) || [];
    if (reset) ST.items = [];
    ST.items = ST.items.concat(items);
    ST.hasMore = items.length >= PAGE_SIZE;
    ST.cursorMs = cursorOf(ST.items);
    if (ST.items.length) ST.hasItems = true;
  }

  /* 已登录但还不知道「有没有消息」时拉一次列表：未读为 0 但条目还在（已读未清空）时，
     按钮必须照样可点 —— 未读数接口给不出这个信息，只能看列表。 */
  function seedList() {
    return api("GET", listPath(PAGE_SIZE, 0))
      .then(function (r) {
        if (r && r.status === 401) {
          resetState();
        } else if (r && r.ok && r.data) {
          absorbPage(r.data, true);
          ST.seeded = true;
        }
        paintEntry();
        return ST;
      })
      .catch(function () {
        paintEntry();
        return ST;
      });
  }

  /* 未读数轮询（唯一对外口：window.MtMessages.refresh；定时器与登录态变化都走它） */
  function refresh() {
    if (!signedIn()) {
      resetState();
      paintEntry();
      return Promise.resolve(ST);
    }
    return api("GET", API_UNREAD)
      .then(function (r) {
        if (r && r.status === 401) {
          /* 未登录（本机会话已过期）：按「未登录」置灰，点一下去登录 */
          resetState();
          paintEntry();
          return ST;
        }
        if (!r || !r.ok || !r.data) {
          /* 未读数接口不可用 → 置灰（需求口径：不可用就不可点） */
          ST.available = false;
          paintEntry();
          return ST;
        }
        ST.available = true;
        ST.unread = Number(r.data.unread) || 0;
        if (ST.unread > 0) ST.hasItems = true;
        if (ST.seeded) {
          paintEntry();
          return ST;
        }
        return seedList();
      })
      .catch(function () {
        ST.available = false;
        paintEntry();
        return ST;
      });
  }

  /* 60 秒轮询：全局只有一个定时器（先清再建，绝不叠加）；页面不可见时跳过这一拍 */
  function ensurePoll() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _timer = setInterval(function () {
      if (document.hidden) return;
      if (!signedIn()) return;
      refresh();
    }, POLL_MS);
  }

  /* ── 标记已读 / 清空 / 分页 ───────────────────────────────── */

  /* 只标记**已展示的条目**：ids 为空数组时绝不发请求（空数组 = 全部已读） */
  function markRead(ids) {
    var list = (ids || []).filter(function (x) {
      return !!x;
    });
    if (!list.length) return Promise.resolve(null);
    return api("POST", API_READ, { ids: list })
      .then(function (r) {
        if (r && r.ok && r.data) {
          var n = Number(r.data.unread);
          ST.unread = isFinite(n) && n >= 0 ? n : 0;
          list.forEach(function (id) {
            ST.items.forEach(function (it) {
              if (it && String(it.id) === String(id)) it.read = true;
            });
          });
          paintEntry();
          return r;
        }
        /* 标记失败就如实留着角标（下一拍轮询会拿到真值），不假装已读 */
        return r;
      })
      .catch(function () {
        return null;
      });
  }

  function clearAll(done) {
    if (ST.busy) return;
    ST.busy = true;
    api("POST", API_CLEAR)
      .then(function (r) {
        if (r && r.ok) {
          ST.unread = 0;
          ST.hasItems = false;
          ST.items = [];
          ST.cursorMs = 0;
          ST.hasMore = false;
          ST.seeded = true;
          paintEntry();
          if (typeof done === "function") done(true);
          toastSafe(T("已清空消息"), "ok");
        } else {
          if (typeof done === "function") done(false, errText(r));
        }
      })
      .catch(function (e) {
        if (typeof done === "function") done(false, String((e && e.message) || e));
      })
      .then(function () {
        ST.busy = false;
      });
  }

  /* ── 消息窗（宿主 = 画布：#overlay，persistent + 可最小化） ───────── */

  function openWindow() {
    if (!signedIn()) {
      openLogin();
      return;
    }
    if (typeof openOverlay !== "function" || typeof closeOverlay !== "function") {
      toastSafe(T("窗口模块未就绪（openOverlay 不存在）"), "err");
      return;
    }
    /* persistent:true = 点蒙层 / 点外部一律不关；min:true = 可以最小化到状态栏 */
    openOverlay(T("消息"), { persistent: true, min: true });
    var body = document.getElementById("ovBody");
    var foot = document.getElementById("ovFoot");
    if (!body || !foot) return;

    var root = el("div", "msg-root");
    root.id = "msgRoot"; /* Esc 出口靠它认「当前这只窗是不是我的」 */
    body.appendChild(root);

    var listBox = el("div", "msg-list");
    root.appendChild(listBox);
    var notice = el("div", "msg-notice hidden");
    root.appendChild(notice);
    function setNotice(text, kind) {
      notice.textContent = text || "";
      notice.className = "msg-notice" + (kind ? " " + kind : "") + (text ? "" : " hidden");
    }

    var more = el("button", "wl-btn ghost msg-act", T("加载更多"));
    more.type = "button";
    var clearBtn = el("button", "wl-btn ghost", T("清空"));
    clearBtn.type = "button";
    var closeBtn = el("button", "wl-btn primary", T("关闭"));
    closeBtn.type = "button";
    closeBtn.addEventListener("click", function () {
      closeOverlay();
    });
    clearBtn.addEventListener("click", function () {
      askClear();
    });
    more.addEventListener("click", function () {
      loadPage(true);
    });
    foot.appendChild(more);
    foot.appendChild(clearBtn);
    foot.appendChild(closeBtn);

    function syncFoot() {
      more.hidden = !ST.hasMore;
      more.disabled = !!ST.busy;
    }

    /* 一条消息：类型标签 · actor 昵称 · 时间 / title / text / 对象 */
    function rowEl(it) {
      var row = el("div", "msg-row" + (it && it.read ? "" : " unread"));
      row.tabIndex = 0;
      var head = el("div", "msg-row-head");
      head.appendChild(el("span", "msg-kind msg-kind-" + kindCls(it && it.kind), kindText(it && it.kind)));
      head.appendChild(el("span", "msg-who", actorName(it)));
      head.appendChild(el("span", "msg-at", tsText(it && it.at)));
      if (it && !it.read) head.appendChild(el("span", "msg-dot", T("未读")));
      row.appendChild(head);
      if (it && it.title) row.appendChild(el("div", "msg-title", it.title));
      if (it && it.text) row.appendChild(el("div", "msg-text", it.text));
      var tl = targetLine(it);
      if (tl) row.appendChild(el("div", "msg-target", tl));
      row.title = T("点一下打开对应入口");
      row.addEventListener("click", function () {
        jumpTo(it);
      });
      row.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") jumpTo(it);
      });
      return row;
    }

    function targetLine(it) {
      var label = targetText(it && it.targetKind);
      var id = String((it && it.targetId) || "");
      if (!label && !id) return "";
      return T("对象") + "：" + (label || String(it.targetKind || "")) + (id ? " · " + id : "");
    }

    function renderList() {
      listBox.innerHTML = "";
      if (!ST.items.length) {
        listBox.appendChild(el("div", "msg-empty", T("还没有消息")));
        syncFoot();
        return;
      }
      ST.items.forEach(function (it) {
        listBox.appendChild(rowEl(it));
      });
      syncFoot();
    }

    /* 一页：fresh = 从第一页重来（开窗 / 清空后），否则按 cursor 拉下一页 */
    function loadPage(next) {
      if (ST.busy) return Promise.resolve(null);
      ST.busy = true;
      syncFoot();
      var cursor = next ? ST.cursorMs : 0;
      return api("GET", listPath(PAGE_SIZE, cursor))
        .then(function (r) {
          if (r && r.status === 401) {
            setNotice(T("登录后可看消息"), "warn");
            return null;
          }
          if (!r || !r.ok || !r.data) {
            setNotice(T("读取失败，请稍后重试") + "（" + errText(r) + "）", "err");
            return null;
          }
          var d = r.data;
          var unread = Number(d.unread);
          if (isFinite(unread) && unread >= 0) ST.unread = unread;
          absorbPage(d, !next);
          ST.seeded = true;
          setNotice("");
          renderList();
          paintEntry();
          /* 打开即把**已展示的条目**标记已读（只带这些 id；空数组 = 全部已读，绝不能误发） */
          var ids = ST.items
            .filter(function (x) {
              return x && !x.read;
            })
            .map(function (x) {
              return x.id;
            });
          return markRead(ids).then(function () {
            renderList(); /* read 标完重绘一次（未读小点消失） */
            return d;
          });
        })
        .catch(function (e) {
          setNotice(String((e && e.message) || e), "err");
          return null;
        })
        .then(function (v) {
          ST.busy = false;
          syncFoot();
          return v;
        });
    }

    function askClear() {
      var ask = T("清空全部消息？清空后不可恢复。");
      var go = function (yes) {
        if (!yes) return;
        setNotice("");
        clearAll(function (ok, err) {
          if (ok) {
            renderList();
            setNotice(T("已清空消息"), "ok");
          } else {
            setNotice(T("清空失败：") + (err || ""), "err");
          }
        });
      };
      /* 清空是不可逆动作：先确认一次（confirmDialog 是独立于 #overlay 的确认框） */
      if (typeof confirmDialog === "function") {
        confirmDialog(ask, { title: T("清空"), okText: T("清空"), danger: true }).then(go);
      } else {
        go(window.confirm(ask));
      }
    }

    more.hidden = true;
    loadPage(false);
  }

  /* ── 跳转（只走既有入口；做不到就如实说，不假装） ───────────── */

  function jumpTo(it) {
    var tk = String((it && it.targetKind) || "");
    var id = String((it && it.targetId) || "");
    if (tk === "app" && id) {
      if (typeof window.openAppsDetail === "function") {
        window.openAppsDetail(id);
        return;
      }
      if (typeof window.openAppsHub === "function") {
        window.openAppsHub("apps");
        return;
      }
    }
    if ((tk === "template" || tk === "skill") && id) {
      openStoreItem(tk, id);
      return;
    }
    if (tk === "forum_topic" || tk === "forum_reply") {
      if (window.api && typeof window.api.forumOpen === "function") {
        var p = window.api.forumOpen();
        if (p && typeof p.then === "function") {
          p.then(function (r) {
            if (r && r.ok) toastSafe(T("已打开讨论区（暂不支持定位到具体话题）"), "warn");
            else toastSafe(T("打开失败：") + String((r && r.error) || ""), "err");
          }).catch(function () {});
        } else {
          toastSafe(T("已打开讨论区（暂不支持定位到具体话题）"), "warn");
        }
        return;
      }
    }
    toastSafe(T("这一类消息暂不支持跳转"), "warn");
  }

  /* 工坊条目（模板 / Skill）：按 id 拉条目 → 走既有条目详情窗（二级浮层，不冲掉本窗） */
  function openStoreItem(kind, id) {
    var base = kind === "skill" ? "/api/skills/" : "/api/templates/";
    api("GET", base + encodeURIComponent(id))
      .then(function (r) {
        if (r && r.ok && r.data && r.data.item && typeof window.openTplItemDetail === "function") {
          window.openTplItemDetail(r.data.item);
          return;
        }
        storeFallback(kind, r);
      })
      .catch(function () {
        storeFallback(kind, null);
      });
  }
  /* 条目详情拉不到：退回「创意工坊 + 落到对应栏目」——仍是真实入口，不是假动作 */
  function storeFallback(kind, r) {
    try {
      if (typeof TPL_ST === "object" && TPL_ST) {
        TPL_ST.kind = kind === "skill" ? "skills" : "templates";
        TPL_ST.page = 1;
      }
    } catch (_) {}
    if (typeof openTemplateStore === "function") {
      openTemplateStore();
      toastSafe(T("条目详情暂时拉不到，已打开创意工坊"), "warn");
      return;
    }
    toastSafe(r ? T("打开失败：") + errText(r) : T("这一类消息暂不支持跳转"), "warn");
  }

  /* ── 显式关闭路径：Esc（另外两条：窗内「关闭」按钮、标题栏 ✕） ──────
     只认自己这只窗：#overlay 当前内容里没有 #msgRoot（已被最小化停放 / 被别的窗顶掉）
     就什么都不做。**本模块不挂任何点外部 / 点蒙层的关闭监听**（persistent 铁律）。 */
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    /* Esc 归「窗内弹出来的确认框」优先（如清空确认 .mt-dialog）：它已经处理过这一下
       （defaultPrevented）或正开着，就不要再顺手把我的消息窗也收掉。 */
    if (ev.defaultPrevented) return;
    if (document.querySelector(".mt-dialog.on")) return;
    var r = document.getElementById("msgRoot");
    if (!r) return;
    var ov = document.getElementById("overlay");
    if (!ov || !ov.contains(r)) return;
    if (typeof closeOverlay === "function") closeOverlay();
  });

  /* ── 接线与初始化（失败只吞在内部，不抛到控制台之外） ───────── */

  /* 订阅登录态：每次重订前先退订，避免叠加 */
  function bindAuth() {
    var A = window.MTNodeAuth;
    if (!A || typeof A.onChange !== "function") return false;
    if (_offAuth) {
      try {
        _offAuth();
      } catch (_) {}
      _offAuth = null;
    }
    _offAuth = A.onChange(function () {
      try {
        refresh();
        ensurePoll(); /* 登录态一变就把轮询对齐（仍是唯一那个定时器） */
      } catch (_) {}
    });
    /* MTNodeAuth.onChange 订阅时**不会补发当前状态**：启动时本机已有会话（最常见的情形）
       就得在这里立刻对齐一次，否则要等到第一拍 60 秒轮询才出角标。 */
    try {
      refresh();
      ensurePoll();
    } catch (_) {}
    return true;
  }
  function bindAuthRetry(n) {
    if (bindAuth()) return;
    /* app-auth.js 排在本文件之后加载：等它上线（最多 10 拍 × 500ms） */
    if (n > 0) setTimeout(function () {
      bindAuthRetry(n - 1);
    }, 500);
  }

  function init() {
    var btn = btnEl();
    if (!btn) return false;
    btn.addEventListener("click", function () {
      try {
        openWindow();
      } catch (e) {
        toastSafe(String((e && e.message) || e), "err");
      }
    });
    /* 切语言后按钮 title / 角标要跟着换：I18n 只有 applyDom、没有订阅口，
       所以在顶栏语言按钮上补一次重绘（挂在那个元素上，不是 document）。 */
    var lang = document.getElementById("btnLang");
    if (lang) {
      lang.addEventListener("click", function () {
        setTimeout(paintEntry, 80);
      });
    }
    paintEntry();
    refresh();
    ensurePoll();
    return true;
  }

  try {
    if (init()) bindAuthRetry(10);
  } catch (e) {
    /* 初始化失败不留半成品：按钮停在「未登录」置灰态即可 */
    try {
      paintEntry();
    } catch (_) {}
  }

  /* ── 对外（app-tips.js / app-comments.js 侧接线只需调用 refresh()） ── */
  window.MtMessages = {
    refresh: refresh,
    open: openWindow,
    paint: paintEntry,
    count: function () {
      return Number(ST.unread) || 0;
    },
    state: function () {
      return {
        signedIn: signedIn(),
        unread: Number(ST.unread) || 0,
        hasItems: !!ST.hasItems,
        available: !!ST.available,
      };
    },
    kindText: kindText,
    targetText: targetText,
  };
})();
