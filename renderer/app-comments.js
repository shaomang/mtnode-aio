/* 评论（工坊条目 / 应用条目 / 论坛话题与回复）——自包含模块，挂 window.MtComments
 *
 * 一、它是什么
 *   一套共用的评论区：列表（含互回）、发表（条目评论可带五星）、删除（本人 / 对象作者 /
 *   管理员）、分页。四个对象类型共用一棵 DOM 树 —— 页面只给 target {kind,id} 与一个容器。
 *
 * 二、口径（真源 store-saas/comments.mjs + docs/tips-comments-design.md）
 *   · 目标类型：template / skill / app / forum_topic / forum_reply；评论支持 parentId 互回。
 *   · **只有条目评论能打分**（template / skill / app）：论坛话题与回复的评论不参与评分，
 *     界面上也不出星星（传了 rating 服务端也会忽略）。
 *   · 评分选填；同一个人对同一个对象只保留最新一颗星（服务端在打分时清旧的，本模块只发起）。
 *   · 平均分与评论数**实时来自服务端**（不本地累加）—— 删除 / 改星后重新拉一次即可。
 *   · 免登录可看；发表与删除需登录，未登录时输入区显示登录入口。
 *
 * 三、形态
 *   · mount(host, target, opts) —— 在容器里整块渲染（详情窗的「评论」页签用）。
 *   · cardEl(item, target, opts) —— 卡片上的一行摘要：平均星 + 评论数（没人评分时不出假分）。
 *   · buttonEl(target, opts) —— 卡片上的「评论」按钮，点开独立评论窗。
 *   · open(target, opts) —— 独立评论窗（工坊 / 应用卡片上的按钮走这里）。
 *
 * 四、依赖
 *   window.api.storeRequest、app.js 的 toast、window.MTNodeAuth（登录态）、optional I18n、
 *   window.MtPop（app-tips.js 的二级浮层，评论窗用它 —— 不用 #overlay 的原因见下方 open()）。
 */
(function () {
  "use strict";

  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
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

  /* 能打分的对象类型（条目评论）；论坛话题 / 回复的评论不评分 */
  var RATED_KINDS = { template: true, skill: true, app: true };
  function rated(kind) {
    return !!RATED_KINDS[kind];
  }

  /* 星级文案：有评分给「4.5 ★ · 12 人评价」，没有评分时按 opts.empty 给一句（默认空串 = 不显示）。 */
  function ratingText(rating, opts) {
    var o = opts || {};
    var n = Number((rating && rating.count) || 0);
    if (!n) return o.empty == null ? "" : o.empty;
    var avg = Number((rating && rating.avg) || 0);
    return avg.toFixed(1) + " ★ · " + T("{n} 人评价", { n: n });
  }
  function commentsText(n) {
    return T("{n} 条评论", { n: Number(n || 0) });
  }

  /* ── 星级选择器（1–5，可清空） ───────────────────────────────
     「选填」：默认 0 星 = 不打分；点同一颗星再点一次可取消。 */
  function starPicker(value, onChange) {
    var box = el("span", "cmt-stars pick");
    var cur = Number(value) || 0;
    function paint() {
      box.innerHTML = "";
      for (var i = 1; i <= 5; i++) {
        (function (n) {
          var s = el("button", "cmt-star" + (n <= cur ? " on" : ""));
          s.type = "button";
          s.textContent = "★";
          s.title = T("{n} 星", { n: n });
          s.addEventListener("click", function () {
            cur = cur === n ? 0 : n;
            paint();
            if (typeof onChange === "function") onChange(cur);
          });
          box.appendChild(s);
        })(i);
      }
    }
    paint();
    box.getValue = function () {
      return cur;
    };
    box.setValue = function (v) {
      cur = Number(v) || 0;
      paint();
    };
    return box;
  }

  /* 只读星级（列表里用；0 星不出星星） */
  function starView(rating) {
    var n = Number(rating) || 0;
    if (!n) return null;
    var box = el("span", "cmt-stars ro");
    for (var i = 1; i <= 5; i++) {
      var s = el("span", "cmt-star" + (i <= n ? " on" : ""));
      s.textContent = "★";
      box.appendChild(s);
    }
    box.title = T("{n} 星", { n: n });
    return box;
  }

  /* ── 卡片上的摘要与按钮 ───────────────────────────────────── */

  /* 卡片一行：`4.5 ★ · 12 人评价 · 3 条评论`（都没有时返回 null，卡片上不占位） */
  function cardEl(item, target, opts) {
    var o = opts || {};
    var rating = item && item.rating;
    var n = Number((item && item.comments) || 0);
    var bits = [];
    if (rated(target.kind)) {
      var rt = ratingText(rating, { empty: "" });
      if (rt) bits.push(rt);
    }
    if (n) bits.push(commentsText(n));
    if (!bits.length) return null;
    var box = el("span", "cmt-meta" + (o.cls ? " " + o.cls : ""));
    box.textContent = bits.join(" · ");
    box.title = T("点击查看评论");
    box.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      open(target, opts);
    });
    return box;
  }

  /* 卡片上的「评论」按钮（图标 + 条数） */
  function buttonEl(target, opts) {
    var o = opts || {};
    var btn = el("button", "cmt-btn");
    btn.type = "button";
    btn.appendChild(el("span", "cmt-btn-ico", "💬"));
    btn.appendChild(el("span", "cmt-btn-t", T("评论")));
    if (o.count) btn.appendChild(el("span", "cmt-btn-n", String(Number(o.count))));
    btn.title = T("查看 / 发表评论");
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      open(target, o);
    });
    return btn;
  }

  /* ── 评论区（整块） ─────────────────────────────────────────
     opts: { title: 显示在标题里的对象名, onChanged: (rating)=>…, pageSize, showHeader, replyTo } */

  function mount(host, target, opts) {
    var o = opts || {};
    if (!host) return null;
    host.innerHTML = "";
    var pageSize = Math.max(1, Number(o.pageSize) || 20);
    var state = { page: 1, total: 0, rating: null, replyTo: null, replyName: "" };

    var root = el("div", "cmt-root");
    host.appendChild(root);

    /* 头部：标题 + 平均星 + 评论数 */
    var head = el("div", "cmt-head");
    if (o.showHeader !== false) {
      var ht = el("div", "cmt-head-t", o.title ? T("评论 · {t}", { t: o.title }) : T("评论"));
      head.appendChild(ht);
    }
    var score = el("div", "cmt-score");
    head.appendChild(score);
    root.appendChild(head);

    /* 发表区 */
    var editor = el("div", "cmt-editor");
    root.appendChild(editor);
    var ta = el("textarea", "cmt-input");
    ta.rows = 4;
    ta.maxLength = 2000;
    ta.placeholder = T("说点什么…（最多 2000 字）");
    var erow = el("div", "cmt-erow");
    var stars = null;
    if (rated(target.kind)) {
      var sk = el("span", "cmt-pick");
      sk.appendChild(el("span", "cmt-pick-k", T("评分（选填）")));
      stars = starPicker(0, null);
      sk.appendChild(stars);
      erow.appendChild(sk);
    }
    var replying = el("span", "cmt-replying hidden");
    erow.appendChild(replying);
    var counter = el("span", "cmt-counter", "0 / 2000");
    erow.appendChild(counter);
    var send = el("button", "wl-btn primary cmt-send", T("发表评论"));
    send.type = "button";
    erow.appendChild(send);
    var notice = el("div", "tip-notice hidden");
    editor.appendChild(ta);
    editor.appendChild(erow);
    editor.appendChild(notice);

    function setNotice(text, kind) {
      notice.textContent = text || "";
      notice.className = "tip-notice" + (kind ? " " + kind : "") + (text ? "" : " hidden");
    }
    ta.addEventListener("input", function () {
      counter.textContent = ta.value.length + " / 2000";
      send.disabled = !ta.value.trim();
    });
    send.disabled = true;

    /* 登录闸：未登录时输入区换成一句提示（免登录仍可看评论） */
    function paintAuth() {
      var on = signedIn();
      ta.disabled = !on;
      send.disabled = !on || !ta.value.trim();
      if (!on) {
        ta.placeholder = T("登录后可以发表评论");
        if (!editor.querySelector(".cmt-login")) {
          var b = el("button", "wl-btn ghost sm cmt-login", T("登录 / 注册"));
          b.type = "button";
          b.addEventListener("click", openLogin);
          erow.insertBefore(b, erow.firstChild);
        }
      } else {
        ta.placeholder = T("说点什么…（最多 2000 字）");
        var old = editor.querySelector(".cmt-login");
        if (old) old.remove();
      }
    }
    paintAuth();

    /* 列表 */
    var listBox = el("div", "cmt-list");
    root.appendChild(listBox);
    var pager = el("div", "cmt-pager");
    root.appendChild(pager);

    function paintScore() {
      score.innerHTML = "";
      if (rated(target.kind)) {
        var rt = ratingText(state.rating, { empty: T("暂无评分") });
        score.appendChild(el("span", "cmt-score-t", rt));
      }
      score.appendChild(el("span", "cmt-score-n", commentsText(state.total)));
    }

    function replyRow(c) {
      var row = el("div", "cmt-row");
      var who = (c.author && (c.author.nickname || c.author.username)) || T("匿名用户");
      var top = el("div", "cmt-row-top");
      top.appendChild(el("span", "cmt-who", who));
      if (rated(target.kind) && c.rating) {
        var sv = starView(c.rating);
        if (sv) top.appendChild(sv);
      }
      top.appendChild(el("span", "cmt-at", tsText(c.createdAt)));
      row.appendChild(top);
      var body = el("div", "cmt-body", c.content || "");
      row.appendChild(body);
      var acts = el("div", "cmt-acts");
      var rb = el("button", "cmt-act", T("回复"));
      rb.type = "button";
      rb.addEventListener("click", function () {
        if (!signedIn()) return openLogin();
        state.replyTo = c.id;
        state.replyName = who;
        replying.textContent = T("回复 @{n}", { n: who });
        replying.classList.remove("hidden");
        ta.focus();
      });
      acts.appendChild(rb);
      if (c.canDelete) {
        var db = el("button", "cmt-act del", T("删除"));
        db.type = "button";
        db.addEventListener("click", function () {
          remove(c);
        });
        acts.appendChild(db);
      }
      row.appendChild(acts);
      return row;
    }

    function paintList(items) {
      listBox.innerHTML = "";
      if (!items || !items.length) {
        listBox.appendChild(el("div", "cmt-empty", T("还没有评论，来说第一句")));
        return;
      }
      items.forEach(function (c) {
        listBox.appendChild(replyRow(c));
      });
    }

    function paintPager() {
      pager.innerHTML = "";
      var pages = Math.max(1, Math.ceil(state.total / pageSize));
      if (pages <= 1) return;
      var prev = el("button", "wl-btn ghost sm", T("上一页"));
      prev.type = "button";
      prev.disabled = state.page <= 1;
      prev.addEventListener("click", function () {
        if (state.page > 1) load(state.page - 1);
      });
      var next = el("button", "wl-btn ghost sm", T("下一页"));
      next.type = "button";
      next.disabled = state.page >= pages;
      next.addEventListener("click", function () {
        if (state.page < pages) load(state.page + 1);
      });
      pager.appendChild(prev);
      pager.appendChild(el("span", "cmt-page-n", state.page + " / " + pages));
      pager.appendChild(next);
    }

    function load(page) {
      state.page = Math.max(1, Number(page) || 1);
      var q =
        "/api/comments?targetKind=" + encodeURIComponent(target.kind) +
        "&targetId=" + encodeURIComponent(target.id) +
        "&page=" + state.page + "&pageSize=" + pageSize;
      return api("GET", q).then(function (r) {
        if (!r || !r.ok || !r.data) {
          paintList([]);
          listBox.appendChild(el("div", "cmt-empty", errText(r)));
          return null;
        }
        var d = r.data;
        state.total = Number(d.total || 0);
        state.rating = d.rating || null;
        paintScore();
        paintList(d.items || []);
        paintPager();
        if (typeof o.onChanged === "function") o.onChanged(state.rating, state.total);
        return d;
      });
    }

    function remove(c) {
      if (!window.confirm(T("确定删除这条评论？"))) return;
      api("DELETE", "/api/comments", { id: c.id }).then(function (r) {
        if (r && r.ok) {
          toastSafe(T("已删除"), "ok");
          load(state.page);
        } else {
          setNotice(errText(r), "err");
        }
      });
    }

    send.addEventListener("click", function () {
      if (!signedIn()) return openLogin();
      var text = ta.value.trim();
      if (!text) return;
      if (text.length > 2000) {
        setNotice(T("评论不能超过 2000 字"), "err");
        return;
      }
      var body = { targetKind: target.kind, targetId: target.id, content: text };
      if (state.replyTo) body.parentId = state.replyTo;
      if (rated(target.kind) && stars && stars.getValue()) body.rating = stars.getValue();
      send.disabled = true;
      api("POST", "/api/comments", body).then(function (r) {
        if (r && r.ok) {
          ta.value = "";
          counter.textContent = "0 / 2000";
          if (stars) stars.setValue(0);
          state.replyTo = null;
          replying.classList.add("hidden");
          setNotice(T("已发表"), "ok");
          load(1);
        } else {
          var code = (r && r.data && r.data.code) || "";
          setNotice(code === "RATE_LIMITED" ? T("评论过于频繁，请稍后再试") : errText(r), "err");
        }
      }).catch(function (e) {
        setNotice(String((e && e.message) || e), "err");
      }).then(function () {
        send.disabled = !ta.value.trim();
      });
    });

    var offAuth = null;
    if (window.MTNodeAuth && typeof window.MTNodeAuth.onChange === "function") {
      offAuth = window.MTNodeAuth.onChange(function () {
        paintAuth();
      });
    }

    load(1);

    return {
      reload: function () {
        return load(state.page);
      },
      destroy: function () {
        if (offAuth) offAuth();
      },
    };
  }

  /* ── 独立评论窗（卡片按钮 / 详情窗外的入口） ───────────────────
     用 window.MtPop（app-tips.js 提供的二级浮层）而不是 app.js 的 #overlay：
     全应用只有一只 #overlay，openOverlay 会清空 #ovBody —— 而工坊 / 应用中心 /
     讨论区本身就在它里面（或各自是独立窗口），在卡片上点「评论」会把宿主窗冲掉。 */
  function open(target, opts) {
    var o = opts || {};
    if (!window.MtPop || typeof window.MtPop.open !== "function") return null;
    var body = window.MtPop.open(T("评论"));
    if (!body) return null;
    var host = el("div", "cmt-window");
    body.appendChild(host);
    var foot = el("div", "mt-pop-foot");
    var close = el("button", "wl-btn primary", T("关闭"));
    close.type = "button";
    close.addEventListener("click", window.MtPop.close);
    foot.appendChild(close);
    body.appendChild(foot);
    return mount(host, target, {
      title: o.title || "",
      pageSize: o.pageSize,
      onChanged: o.onChanged,
    });
  }

  window.MtComments = {
    mount: mount,
    open: open,
    cardEl: cardEl,
    buttonEl: buttonEl,
    ratingText: ratingText,
    commentsText: commentsText,
    rated: rated,
  };
})();
