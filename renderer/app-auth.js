"use strict";
/* renderer/app-auth.js — MTNode 统一账户客户端模块（自包含）
 * ============================================================================
 * 公开接口（全局 window.MTNodeAuth）：
 *   state()                  同步快照 { ready, unavailable, signedIn, user, nickname,
 *                                      avatar, phone, bindings{phone,wechat,password}, hasPassword }
 *   refresh()                重新向主进程拉登录态
 *   login.password({username,password})
 *   login.sms.send({phone,scene}) / login.sms.verify({phone,code})
 *   login.wechat.start({scene})   / login.wechat.poll({deviceCode})
 *   bind(kind, payload)      绑定手机 / 微信（kind = phone | wechat）
 *   unbind(kind, payload)    解绑
 *   logout()
 *   onChange(cb)             订阅登录态变化，返回退订函数
 *   methods()                当前对界面开放的登录方式快照 { sms, wechat, password }
 *   open(tab) / close()      打开 / 关闭登录对话框（未开放的方式由 METHOD_ON 规范化退回第一项）
 *   paint()                  重绘顶栏账户入口
 *
 * 主进程 IPC 契约（由主进程账户模块 + preload 提供；本模块按名称探测，缺失时降级为
 * 「登录服务未就绪」而不是抛异常）：
 *   authState()                     -> { ok, signedIn, user }
 *   authLoginPassword({username,password})
 *   authSmsSend({phone,scene})      -> { ok, expiresIn, cooldown }
 *   authSmsLogin({phone,code})      -> { ok, user, created }
 *   authWechatStart({scene})        -> { ok, deviceCode, authUrl, qrDataUrl?, expiresIn, interval }
 *   authWechatPoll({deviceCode})    -> { ok, status:"pending"|"done", user?, ticket? }
 *   authBind({kind,...}) / authUnbind({kind,...}) / authLogout()
 *   onAuthChanged(cb)               主进程推送登录态变化（可选）
 * 兼容别名见 METHODS 表。token 一律由主进程保管（safeStorage），渲染层只拿 user 快照。
 * ============================================================================
 */
(function () {
  var T = function (s) {
    return window.I18n && window.I18n.t ? window.I18n.t(s) : String(s);
  };
  /* 带变量的 i18n：模板用 {name} 占位（I18n 未接入时退回原模板） */
  var $id = function (id) {
    return document.getElementById(id);
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ───────────────────── 登录方式开关（单一真源） ─────────────────────
   * 顶栏账户入口已启用：目前开放「微信扫码登录 / 绑定微信」，并已重新开放
   * 「账号密码登录」（老账号迁移用）；仍无注册通道——密码页签只做登录，不提供
   * 注册入口。未开放的方式既不进页签，也不进账户菜单。
   * 手机验证码登录 / 绑定手机暂时隐藏（sms:false）：手机页签、「绑定手机」菜单项
   * 与手机绑定徽章一并收起；主进程 IPC 与短信实现全部保留，恢复只需把这里改 true，
   * 并同步 test/smoke-auth.js 的开关断言。
   * 三项全 false 时 init 会把顶栏入口重新隐藏。 */
  var METHOD_ON = { sms: false, wechat: true, password: true };
  var LOGIN_TABS = [
    ["wechat", "微信扫码"],
    ["sms", "手机验证码"],
    ["password", "账号密码"],
  ];

  function methodOn(kind) {
    return !!METHOD_ON[kind];
  }

  function enabledTabs() {
    return LOGIN_TABS.filter(function (p) {
      return methodOn(p[0]);
    });
  }

  function firstEnabledTab() {
    var t = enabledTabs();
    return t.length ? t[0][0] : "";
  }

  /* ───────────────────────── 登录态快照 + 订阅 ───────────────────────── */
  var SNAP = {
    ready: false,
    unavailable: false,
    signedIn: false,
    user: null,
    nickname: "",
    avatar: "",
    phone: "",
    bindings: { phone: false, wechat: false, password: false },
    hasPassword: false,
  };
  var subs = new Set();

  function notify() {
    subs.forEach(function (cb) {
      try {
        cb(state());
      } catch (e) {
        if (window.console) console.error("MTNodeAuth onChange", e);
      }
    });
  }

  function applyUser(user) {
    SNAP.user = user || null;
    SNAP.signedIn = !!user;
    var b = (user && user.bindings) || {};
    SNAP.nickname = (user && (user.nickname || user.username)) || "";
    SNAP.avatar = (user && user.avatar) || "";
    SNAP.phone = (user && user.phone) || "";
    SNAP.bindings = {
      phone: !!b.phone || !!(user && user.phone),
      wechat: !!b.wechat,
      password: !!b.password || !!(user && user.hasPassword),
    };
    SNAP.hasPassword = SNAP.bindings.password;
    notify();
    paintEntry();
    if (menuOpen()) paintMenu();
  }

  function state() {
    return {
      ready: SNAP.ready,
      unavailable: SNAP.unavailable,
      signedIn: SNAP.signedIn,
      user: SNAP.user,
      nickname: SNAP.nickname,
      avatar: SNAP.avatar,
      phone: SNAP.phone,
      bindings: Object.assign({}, SNAP.bindings),
      hasPassword: SNAP.hasPassword,
    };
  }

  function onChange(cb) {
    if (typeof cb !== "function") return function () {};
    subs.add(cb);
    return function () {
      subs.delete(cb);
    };
  }

  /* ───────────────────────── IPC 桥（按名称探测） ───────────────────────── */
  var METHODS = {
    state: ["authState", "authGetState", "authStatus"],
    password: ["authLoginPassword", "authPasswordLogin", "authLogin"],
    smsSend: ["authSmsSend", "authSendSms"],
    smsLogin: ["authSmsLogin", "authSmsVerify"],
    wechatStart: ["authWechatStart", "authWechatQr", "authQrStart"],
    wechatPoll: ["authWechatPoll", "authQrPoll"],
    bind: ["authBind"],
    unbind: ["authUnbind"],
    logout: ["authLogout"],
  };

  function bridge() {
    return window.api || null;
  }

  function method(name) {
    var a = bridge();
    if (!a) return null;
    var names = METHODS[name] || [];
    for (var i = 0; i < names.length; i++) {
      if (typeof a[names[i]] === "function") return a[names[i]].bind(a);
    }
    return null;
  }

  function call(name, payload) {
    var m = method(name);
    if (!m) {
      return Promise.resolve({
        ok: false,
        code: "NO_BRIDGE",
        error: T("登录服务未就绪（主进程账户模块尚未接入）"),
      });
    }
    return Promise.resolve()
      .then(function () {
        return m(payload || {});
      })
      .then(function (r) {
        return r && typeof r === "object" ? r : { ok: !!r };
      })
      .catch(function (e) {
        return {
          ok: false,
          code: "IPC_ERROR",
          error: (e && e.message) || T("与主进程通信失败"),
        };
      });
  }

  var CODE_TEXT = {
    BAD_CREDENTIALS: "用户名或密码错误",
    INVALID_PHONE: "手机号格式不正确",
    INVALID_PASSWORD: "密码长度需 6-72 位",
    INVALID_NICKNAME: "昵称长度需 1-32 位",
    INVALID_JSON: "请求格式不正确",
    CODE_INVALID: "验证码错误",
    CODE_EXPIRED: "验证码已过期，请重新获取",
    RATE_LIMITED: "操作太频繁，请稍后再试",
    SMS_UNAVAILABLE: "短信服务暂不可用，请稍后再试",
    WECHAT_UNAVAILABLE: "微信登录暂不可用",
    REGISTER_DISABLED: "用户名密码注册已停用，请用手机验证码或微信登录",
    PHONE_IN_USE: "该手机号已被其它账号绑定",
    PHONE_ALREADY_BOUND: "当前账号已绑定其它手机号",
    WECHAT_IN_USE: "该微信已被其它账号绑定",
    WECHAT_OWNED_BY_OTHER: "该微信已绑定其它账号，请选择改用该微信登录或取消",
    WECHAT_ALREADY_BOUND: "当前账号已绑定微信",
    SECOND_FACTOR_REQUIRED: "请先完成二次验证",
    SECOND_FACTOR_FAILED: "二次验证失败",
    UNAUTHORIZED: "登录已失效，请重新登录",
    NOT_BOUND: "该登录方式尚未绑定",
    LAST_CREDENTIAL: "至少保留一种登录方式",
    PASSWORD_ALREADY_SET: "当前账号已设置密码",
    UNKNOWN_KIND: "不支持的绑定类型",
    NO_BRIDGE: "登录服务未就绪（主进程账户模块尚未接入）",
    IPC_ERROR: "与主进程通信失败",
  };

  /* 服务端原始英文 / 未知错误的兜底文案（不把 not found、Internal Server Error 之类甩给用户） */
  var ERR_FALLBACK = "登录服务暂时不可用，请稍后重试";

  function isLocalizedError(s) {
    return /[\u4e00-\u9fff]/.test(s);
  }

  function errText(r) {
    if (!r) return T(ERR_FALLBACK);
    if (r.code && CODE_TEXT[r.code]) return T(CODE_TEXT[r.code]);
    var raw = r.error == null ? "" : String(r.error).trim();
    /* 只有已经是中文的文案才原样透出，其余（英文原文 / 空 / 未知）统一兜底 */
    if (raw && isLocalizedError(raw)) return raw;
    return T(ERR_FALLBACK);
  }

  /* ───────────────────────── 登录态刷新 ───────────────────────── */
  function refresh() {
    var m = method("state");
    if (!m) {
      SNAP.ready = true;
      SNAP.unavailable = true;
      SNAP.signedIn = false;
      SNAP.user = null;
      notify();
      paintEntry();
      if (menuOpen()) paintMenu();
      return Promise.resolve(state());
    }
    return Promise.resolve()
      .then(function () {
        return m();
      })
      .then(function (r) {
        var res = r && typeof r === "object" ? r : {};
        var user = res.user || null;
        SNAP.ready = true;
        SNAP.unavailable = false;
        if (user) {
          SNAP.user = user;
          SNAP.signedIn = true;
          var b = user.bindings || {};
          SNAP.nickname = user.nickname || user.username || "";
          SNAP.avatar = user.avatar || "";
          SNAP.phone = user.phone || "";
          SNAP.bindings = {
            phone: !!b.phone || !!user.phone,
            wechat: !!b.wechat,
            password: !!b.password || !!user.hasPassword,
          };
          SNAP.hasPassword = SNAP.bindings.password;
        } else {
          SNAP.user = null;
          SNAP.signedIn = !!(res.signedIn && user);
          SNAP.nickname = "";
          SNAP.avatar = "";
          SNAP.phone = "";
          SNAP.bindings = { phone: false, wechat: false, password: false };
          SNAP.hasPassword = false;
        }
        notify();
        paintEntry();
        if (menuOpen()) paintMenu();
        return state();
      })
      .catch(function () {
        SNAP.ready = true;
        return state();
      });
  }

  /* ───────────────────────── 顶栏账户入口 ───────────────────────── */
  function paintEntry() {
    var btn = $id("btnAccount");
    if (!btn) return;
    var nameEl = $id("acctName");
    var signed = SNAP.signedIn;
    var u = SNAP.user || {};
    var name = signed ? u.nickname || u.username || T("账户") : T("登录");
    if (nameEl) {
      nameEl.textContent = name;
      if (signed) nameEl.removeAttribute("data-i18n");
      else nameEl.setAttribute("data-i18n", "登录");
    }
    btn.classList.toggle("on", signed);
    /* 登录后顶栏悬停提示直接显示账号 ID（未登录恢复通用提示）：
       摘掉 data-i18n-title，避免切语言时被 applyDom 覆盖回无 ID 的文案。 */
    if (signed && u.id) {
      btn.removeAttribute("data-i18n-title");
      btn.title = String(u.id);
      btn.setAttribute("aria-label", T("账户") + " " + u.id);
    } else {
      btn.setAttribute("data-i18n-title", "账户：登录 / 绑定 / 退出");
      btn.title = T("账户：登录 / 绑定 / 退出");
      btn.setAttribute("aria-label", T("账户"));
    }
  }

  /* ───────────────────────── 账户菜单（persistent） ───────────────────────── */
  function menuOpen() {
    var m = $id("accountMenu");
    return !!(m && m.classList.contains("on"));
  }

  function ensureMenu() {
    var menu = $id("accountMenu");
    if (menu) return menu;
    menu = el("div", "account-menu");
    menu.id = "accountMenu";
    menu.tabIndex = -1;
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    /* persistent：菜单里有绑定 / 退出等动作，点外部不收起；关闭只走 ✕ / Esc /
       再点一次账户按钮（AGENTS.md 顶栏面板口径）。开别的顶栏面板时按互斥收掉。 */
    menu.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeAccountMenu();
      }
    });
    return menu;
  }

  function positionMenu() {
    var menu = $id("accountMenu");
    var btn = $id("btnAccount");
    if (!menu || !btn || !menu.classList.contains("on")) return;
    var r = btn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + "px";
    menu.style.right = Math.round(Math.max(8, window.innerWidth - r.right)) + "px";
  }

  function menuItem(label, fn, danger) {
    var b = el("button", "mini acct-item" + (danger ? " acct-danger" : ""), label);
    b.type = "button";
    b.onclick = function () {
      fn();
    };
    return b;
  }

  /* 名字下方的绑定徽章：内联 SVG + currentColor（不引第三方图标库/图片资源）。
     已绑微信 → 微信气泡图标；已绑手机 → 手机图标 + 号码文本。纯展示，无点击行为。
     手机徽章跟随 METHOD_ON.sms：手机绑定暂时隐藏时连徽章一起收起。 */
  function badgeIcon(kind) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var ds =
      kind === "phone"
        ? ["M7 2.5h10a2.2 2.2 0 0 1 2.2 2.2v14.6a2.2 2.2 0 0 1-2.2 2.2H7a2.2 2.2 0 0 1-2.2-2.2V4.7A2.2 2.2 0 0 1 7 2.5z", "M10.4 18.6h3.2"]
        : [
            "M8.6 4C5.1 4 2.5 6.3 2.5 9.1c0 1.6.8 3 2.1 3.9L4 15l2.3-1.2c.7.2 1.5.3 2.3.3",
            "M15.4 8.4c3 0 5.6 2.1 5.6 4.8 0 1.4-.7 2.6-1.8 3.4l.5 1.9-2-1c-.6.1-1.2.2-1.9.2-3 0-5.6-2.1-5.6-4.8s2.5-4.5 5.2-4.5z",
          ];
    for (var i = 0; i < ds.length; i++) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", ds[i]);
      svg.appendChild(p);
    }
    return svg;
  }

  function badgesNode(u) {
    var row = el("div", "acct-badges");
    if (SNAP.bindings.wechat) {
      var w = el("span", "acct-badge acct-badge-wechat");
      w.title = T("已绑定微信");
      w.setAttribute("aria-label", T("已绑定微信"));
      w.appendChild(badgeIcon("wechat"));
      row.appendChild(w);
    }
    if (methodOn("sms") && SNAP.bindings.phone) {
      var p = el("span", "acct-badge acct-badge-phone");
      p.title = T("已绑定手机");
      p.setAttribute("aria-label", T("已绑定手机"));
      p.appendChild(badgeIcon("phone"));
      row.appendChild(p);
      var num = u.phone || "";
      if (num) {
        var txt = el("span", "acct-badge-txt", num);
        txt.title = num;
        row.appendChild(txt);
      }
    }
    return row;
  }

  function paintMenu() {
    var menu = ensureMenu();
    menu.innerHTML = "";
    var u = SNAP.user || {};
    var head = el("div", "acct-head");
    var meta = el("div", "acct-meta");
    meta.appendChild(
      el("div", "acct-name", SNAP.signedIn ? u.nickname || u.username || T("账户") : T("未登录")),
    );
    /* 已绑定微信（手机绑定暂时隐藏时手机徽章一并收起）→ 名字下方显示图标徽章；
       已登录时恒定显示账号 ID 本身（不带「账号 ID：」前缀，可选中复制），未登录才退回提示行。 */
    if (
      SNAP.signedIn &&
      (SNAP.bindings.wechat || (methodOn("sms") && SNAP.bindings.phone))
    ) {
      meta.appendChild(badgesNode(u));
    }
    if (SNAP.signedIn) {
      /* 只渲染 id 本身（真实 u.id），不加「账号 ID：」前缀；id 缺失才退回占位符。 */
      var idLine = el("div", "acct-sub acct-id", u.id ? String(u.id) : "—");
      if (u.id) idLine.title = String(u.id);
      meta.appendChild(idLine);
    } else {
      meta.appendChild(
        el(
          "div",
          "acct-sub",
          SNAP.unavailable ? T("账户服务未就绪") : T("登录后账号数据随设备同步"),
        ),
      );
    }
    head.appendChild(meta);
    var x = el("button", "mini btn-sq acct-x", "✕");
    x.type = "button";
    x.title = T("关闭");
    x.onclick = closeAccountMenu;
    head.appendChild(x);
    menu.appendChild(head);

    var body = el("div", "acct-body");
    if (!SNAP.signedIn) {
      var go = el("button", "mini primary acct-item acct-item-primary", T("登录"));
      go.type = "button";
      go.onclick = function () {
        openAuthDialog("login");
      };
      body.appendChild(go);
      if (SNAP.unavailable) {
        body.appendChild(
          el("div", "acct-note", T("登录服务未就绪：主进程账户模块尚未接入")),
        );
      }
    } else {
      if (methodOn("sms") && !SNAP.bindings.phone) {
        body.appendChild(
          menuItem(T("绑定手机"), function () {
            openAuthDialog("bindPhone");
          }),
        );
      }
      if (methodOn("wechat")) {
        if (!SNAP.bindings.wechat) {
          body.appendChild(
            menuItem(T("绑定微信"), function () {
              openAuthDialog("bindWechat");
            }),
          );
        }
      }
      body.appendChild(
        menuItem(T("修改昵称"), function () {
          openNickDialog();
        }),
      );
      body.appendChild(
        menuItem(T("退出登录"), function () {
          doLogout();
        }, true),
      );
    }
    menu.appendChild(body);
  }

  function openAccountMenu() {
    try {
      if (typeof closeApprovalsPanel === "function") closeApprovalsPanel();
    } catch (_) {}
    try {
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept(null);
    } catch (_) {}
    var menu = ensureMenu();
    paintMenu();
    menu.classList.add("on");
    var btn = $id("btnAccount");
    if (btn) btn.classList.add("on");
    positionMenu();
    menu.focus();
  }

  function closeAccountMenu() {
    var menu = $id("accountMenu");
    if (menu) menu.classList.remove("on");
    var btn = $id("btnAccount");
    if (btn) btn.classList.remove("on");
  }

  function toggleAccountMenu() {
    if (menuOpen()) closeAccountMenu();
    else openAccountMenu();
  }

  /* ───────────────────────── 登录 / 绑定对话框 ───────────────────────── */
  var AUTH = {
    open: false,
    mode: "login", // login | bindPhone | bindWechat
    tab: "", // wechat | sms | password（由 openAuthDialog 按 METHOD_ON 规范化）
    /* 「微信已绑定其它账号」→「改用该微信登录」时置 true：本次强制走登录意图
       （scene=login / poll done 走 onSession），不受「已登录但未绑微信即绑定」的默认判定影响 */
    forceLogin: false,
    host: null,
    poll: {
      timer: null,
      deviceCode: "",
      interval: 2000,
      deadline: 0,
      mode: "",
      /* 开放平台 qrconnect 页地址（用默认浏览器打开的那一个） */
      loginUrl: "",
      /* 本次对话框是否已自动用默认浏览器打开过微信登录页（防重复弹窗） */
      autoOpened: false,
    },
    expTimer: null,
    cdTimer: null,
    cooldown: 0,
  };

  function ensureAuthHost() {
    if (AUTH.host) return AUTH.host;
    var host = el("div", "mt-dialog auth-dlg");
    host.id = "authDlg";
    host.tabIndex = -1;
    host.innerHTML =
      '<div class="mt-dialog-box auth-box" role="dialog" aria-modal="true" aria-labelledby="authTitle">' +
      '<div class="mt-dialog-head auth-head">' +
      '<b id="authTitle"></b>' +
      '<div class="auth-tabs" id="authTabs"></div>' +
      '<button type="button" class="mini node-guide-x" id="authClose" title="' +
      T("关闭") +
      '">✕</button>' +
      "</div>" +
      '<div class="mt-dialog-body auth-body" id="authBody"></div>' +
      "</div>";
    document.body.appendChild(host);
    host.querySelector("#authClose").onclick = function () {
      closeAuthDialog();
    };
    /* persistent：登录 / 绑定表单里全是输入项，点蒙层不关窗，只走 ✕ / Esc */
    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      closeAuthDialog();
    });
    AUTH.host = host;
    return host;
  }

  function openAuthDialog(mode, tab, forceLogin) {
    ensureAuthHost();
    try {
      if (typeof closeApprovalsPanel === "function") closeApprovalsPanel();
    } catch (_) {}
    try {
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept(null);
    } catch (_) {}
    closeAccountMenu();
    AUTH.mode = mode || "login";
    /* 「改用该微信登录」流程强制登录意图；其余入口一律回到默认绑定 / 登录判定 */
    AUTH.forceLogin = !!forceLogin;
    /* 未开放的方式不进对话框：微信绑定退回手机绑定；页签退回到已开启的第一项 */
    if (AUTH.mode === "bindWechat" && !methodOn("wechat")) {
      AUTH.mode = methodOn("sms") ? "bindPhone" : "login";
    }
    /* 未显式指定页签（顶栏「登录」等入口）一律回到「第一个已开启的方式」——
       否则会沿用上次停留的页签（如手机验证码 / 账号密码），看不到微信扫码入口。 */
    var want = tab || "";
    AUTH.tab = want && methodOn(want) ? want : firstEnabledTab();
    AUTH.open = true;
    /* 每次进入对话框，微信页都要重新自动用默认浏览器打开一次 */
    AUTH.poll.autoOpened = false;
    renderAuthDialog();
    AUTH.host.classList.add("on");
    AUTH.host.focus();
  }

  function closeAuthDialog() {
    stopTimers();
    closeWechatOwnerDialog();
    if (AUTH.host) AUTH.host.classList.remove("on");
    AUTH.open = false;
    AUTH.forceLogin = false;
    /* 下次再开对话框，微信页要重新自动用默认浏览器打开一次 */
    AUTH.poll.autoOpened = false;
  }

  function stopWechat() {
    if (AUTH.poll.timer) {
      clearTimeout(AUTH.poll.timer);
      AUTH.poll.timer = null;
    }
    if (AUTH.expTimer) {
      clearTimeout(AUTH.expTimer);
      AUTH.expTimer = null;
    }
    AUTH.poll.deviceCode = "";
    AUTH.poll.loginUrl = "";
  }

  function stopTimers() {
    stopWechat();
    if (AUTH.cdTimer) {
      clearInterval(AUTH.cdTimer);
      AUTH.cdTimer = null;
    }
    AUTH.cooldown = 0;
  }

  function showErr(id, msg) {
    var n = $id(id);
    if (!n) return;
    n.textContent = msg || "";
    n.hidden = !msg;
  }

  function submitOnEnter(inp, fn) {
    if (!inp) return;
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        fn();
      }
    });
  }

  function field(labelText, inputId, type, placeholder, attrs) {
    var f = el("label", "auth-fld");
    f.appendChild(el("span", "", T(labelText)));
    var inp = document.createElement("input");
    inp.id = inputId;
    inp.type = type || "text";
    if (placeholder) inp.placeholder = T(placeholder);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        inp.setAttribute(k, attrs[k]);
      });
    }
    f.appendChild(inp);
    return f;
  }

  function renderAuthDialog() {
    var host = AUTH.host;
    if (!host) return;
    var titleEl = host.querySelector("#authTitle");
    var tabsEl = host.querySelector("#authTabs");
    var body = host.querySelector("#authBody");
    if (!titleEl || !tabsEl || !body) return;
    stopTimers();

    var isLogin = AUTH.mode === "login";
    titleEl.textContent = isLogin
      ? T("登录 MTNode 账户")
      : AUTH.mode === "bindPhone"
        ? T("绑定手机号")
        : T("绑定微信");

    tabsEl.innerHTML = "";
    var tabs = isLogin ? enabledTabs() : [];
    /* 只剩一种登录方式时不必再给页签条，直接把那一页铺满 */
    tabsEl.hidden = !(isLogin && tabs.length > 1);
    tabs.forEach(function (pair) {
      var b = el("button", "auth-tab" + (AUTH.tab === pair[0] ? " on" : ""), T(pair[1]));
      b.type = "button";
      b.onclick = function () {
        if (AUTH.tab === pair[0]) return;
        AUTH.tab = pair[0];
        renderAuthDialog();
      };
      tabsEl.appendChild(b);
    });

    body.innerHTML = "";
    if (!AUTH.tab) {
      body.appendChild(el("div", "auth-hint", T("登录方式暂未开放")));
      return;
    }
    if (AUTH.mode === "bindPhone") paintBindPhonePane(body);
    else if (AUTH.mode === "bindWechat") paintWechatPane(body, "bindWechat");
    else if (AUTH.tab === "wechat") paintWechatPane(body, "login");
    else if (AUTH.tab === "sms") paintSmsPane(body);
    else paintPasswordPane(body);
  }

  /* ---------- 微信扫码 ---------- */
  /* 微信授权成功、但主进程没落库（绑定 / 会话未生效）时的统一兜底文案：
     登录与绑定两种意图共用；key 已在 i18n 中英成对。 */
  var WECHAT_NOT_EFFECTIVE =
    "微信授权成功但绑定未生效，请重试；若持续失败请升级并重新部署账户服务";

  function setQrStatus(txt, kind) {
    var n = $id("authQrStatus");
    if (!n) return;
    n.textContent = txt || "";
    n.className = "auth-qr-status" + (kind ? " " + kind : "");
  }

  /* 已用默认浏览器打开过微信登录页：换掉按钮文案并给出状态提示 */
  function markWechatOpened() {
    AUTH.poll.autoOpened = true;
    var btn = $id("authQrOpenBrowser");
    if (btn) btn.textContent = T("重新打开微信登录");
    setQrStatus(T("已用默认浏览器打开微信登录，请在浏览器完成扫码或在微信中确认"));
  }

  /* 绑定意图（本次故障根因）：从「绑定微信」入口进来，或已登录但还没绑微信，
     都算绑定 —— startWechat 传 {scene:"bind"}、poll done 后按绑定分流；
     未登录才是匿名登录。 */
  function isBindIntent() {
    /* 「改用该微信登录（切换到该账号）」显式要求登录意图，覆盖下面的默认判定 */
    if (AUTH.forceLogin) return false;
    return AUTH.mode === "bindWechat" || (SNAP.signedIn && !SNAP.bindings.wechat);
  }

  function paintWechatPane(body, mode) {
    /* 微信登录唯一通道＝系统默认浏览器：本页只有一颗主按钮 + 状态行（绑定页多一颗「返回」）。
       不做内嵌 iframe、不做应用内小窗、不做本机微信检测，也不出现任何密码 / 验证码输入。 */
    var wrap = el("div", "auth-qr-wrap");

    var status = el("div", "auth-qr-status");
    status.id = "authQrStatus";
    wrap.appendChild(status);

    /* 主按钮：进入本页已自动打开过一次，之后点它可再次打开 */
    var primary = el(
      "button",
      "auth-qr-open auth-qr-open-primary",
      T("用默认浏览器打开微信登录"),
    );
    primary.type = "button";
    primary.id = "authQrOpenBrowser";
    primary.disabled = false;
    primary.onclick = function () {
      openWechatInBrowser(mode);
    };
    wrap.appendChild(primary);

    if (mode === "bindWechat") {
      var back = el("button", "mini auth-back", T("返回"));
      back.type = "button";
      back.onclick = function () {
        openAuthDialog("login");
      };
      wrap.appendChild(back);
    }
    body.appendChild(wrap);
    startWechat(mode);
  }

  function startWechat(mode) {
    stopWechat();
    setQrStatus(T("正在打开微信快捷登录…"));
    var params = isBindIntent() ? { scene: "bind" } : {};
    call("wechatStart", params).then(function (r) {
      if (!AUTH.open) return;
      if (!r.ok) {
        setQrStatus(errText(r), "err");
        return;
      }
      AUTH.poll.deviceCode = r.deviceCode || r.device_code || "";
      AUTH.poll.interval = Math.max(1, Number(r.interval) || 2) * 1000;
      AUTH.poll.deadline =
        Date.now() + (Number(r.expiresIn || r.expires_in) || 300) * 1000;
      AUTH.poll.mode = mode;
      AUTH.poll.loginUrl = r.authUrl || r.url || "";
      /* 进入微信页即自动用默认浏览器打开一次；重渲染 / 再次进入不重复弹窗，按钮仍可再打开 */
      if (AUTH.poll.loginUrl && !AUTH.poll.autoOpened) {
        if (window.api && window.api.openExternal) {
          window.api.openExternal(AUTH.poll.loginUrl);
        }
        markWechatOpened();
      }
      schedulePoll();
      scheduleExpiry();
    });
  }

  /* 用系统默认浏览器打开微信快捷登录页（qrconnect 页需顶层窗口）。
     尚未取到 authUrl（首次打开或上次 start 失败）时先取 start，取到后 startWechat 会自动打开。 */
  function openWechatInBrowser(mode) {
    var u = AUTH.poll.loginUrl || "";
    if (!u) {
      startWechat(mode || AUTH.poll.mode || "login");
      return;
    }
    if (window.api && window.api.openExternal) window.api.openExternal(u);
    markWechatOpened();
  }

  function schedulePoll() {
    AUTH.poll.timer = setTimeout(pollWechat, AUTH.poll.interval);
  }

  function pollWechat() {
    if (!AUTH.open || !AUTH.poll.deviceCode) return;
    var code = AUTH.poll.deviceCode;
    call("wechatPoll", { deviceCode: code }).then(function (r) {
      if (!AUTH.open || AUTH.poll.deviceCode !== code) return;
      if (!r.ok) {
        if (r.code === "CODE_EXPIRED") return markQrExpired();
        /* 该微信属于别的账号：不当作普通错误、不再重扫，交给用户自己决定合并 / 切换 */
        if (r.code === "WECHAT_OWNED_BY_OTHER") return onWechatOwnedByOther(r);
        if (r.code === "WECHAT_UNAVAILABLE") {
          setQrStatus(errText(r), "err");
          return;
        }
        setQrStatus(errText(r), "err");
        schedulePoll();
        return;
      }
      if (r.status === "done") return onWechatDone(r);
      if (r.status === "expired") return markQrExpired();
      /* 扫码 / 确认都在默认浏览器里完成，这里只轮询，不改状态行 */
      schedulePoll();
    });
  }

  function scheduleExpiry() {
    if (AUTH.expTimer) clearTimeout(AUTH.expTimer);
    var ms = Math.max(1000, AUTH.poll.deadline - Date.now());
    AUTH.expTimer = setTimeout(function () {
      if (AUTH.open && AUTH.poll.deviceCode) markQrExpired();
    }, ms);
  }

  function markQrExpired() {
    stopWechat();
    setQrStatus(T("微信登录已超时，请重新点击「用默认浏览器打开微信登录」"), "err");
  }

  /* 微信侧 done 只代表「授权成功」；绑定 / 会话是否真的生效，一律以主进程落库结果为准：
     refresh() 后查快照，生效才提示成功并关窗，没生效就留在对话框里、可重开浏览器重扫。 */
  function onWechatDone(r) {
    /* 该微信已绑定到别的账号：不关窗、不再重扫，弹出选择对话框让用户自己决定 */
    if (r && r.code === "WECHAT_OWNED_BY_OTHER") return onWechatOwnedByOther(r);
    /* 绑定意图判定与 startWechat 一致：绑定分流不再等 ticket、不再调 auth:bind、
       也不传任何密码；登录意图才走 onSession。 */
    var bindIntent = isBindIntent();
    stopWechat();
    if (bindIntent) {
      if (r.user) applyUser(r.user);
      /* 临时微信账号被合并进来时（r.merged）给专门的提示文案，与普通绑定成功区分 */
      var merged = !!r.merged;
      refresh().then(function () {
        if (!AUTH.open) return;
        if (SNAP.signedIn && (SNAP.bindings.wechat || merged)) {
          toast(
            merged
              ? T("已把微信绑定到当前账号（原临时微信账号已合并）")
              : T("微信绑定成功"),
          );
          closeAuthDialog();
          return;
        }
        setQrStatus(T(WECHAT_NOT_EFFECTIVE), "err");
      });
      return;
    }
    onSession(r, T("登录成功"), function (ok) {
      if (!ok && AUTH.open) setQrStatus(T(WECHAT_NOT_EFFECTIVE), "err");
    });
  }

  /* ── 该微信已绑定其它账号：让用户自己选「改用该微信登录（切换到该账号）」还是「取消」 ──
     不关窗（下面的微信对话框保留）、不再重扫；对话框 persistent，点蒙层不关，
     只走 ✕ / Esc / 取消，或在窗内确认切换账号。 */
  var OWNER = { host: null };

  function maskPhone(p) {
    var s = String(p || "").trim();
    if (!s || s.indexOf("*") >= 0) return s;
    var d = s.replace(/\D/g, "");
    if (d.length === 11) return d.slice(0, 3) + "****" + d.slice(7);
    if (d.length > 4) return d.slice(0, 2) + "****" + d.slice(-2);
    return s;
  }

  function ownerMetaText(o) {
    o = o || {};
    var parts = [];
    var ph = maskPhone(o.phone);
    if (ph) parts.push(ph);
    /* 服务端 owner 摘要的密码标记兼容 hasPassword / password 两种字段名 */
    parts.push(o.hasPassword || o.password ? T("已设置密码") : T("未设置密码"));
    return parts.join(" · ");
  }

  function ensureWechatOwnerHost() {
    if (OWNER.host) return OWNER.host;
    var host = el("div", "mt-dialog auth-dlg auth-owner-dlg");
    host.id = "authOwnerDlg";
    host.tabIndex = -1;
    host.innerHTML =
      '<div class="mt-dialog-box auth-box" role="dialog" aria-modal="true" aria-labelledby="authOwnerTitle">' +
      '<div class="mt-dialog-head auth-head">' +
      '<b id="authOwnerTitle"></b>' +
      '<button type="button" class="mini node-guide-x" id="authOwnerClose" title="' +
      T("取消") +
      '">✕</button>' +
      "</div>" +
      '<div class="mt-dialog-body auth-body" id="authOwnerBody"></div>' +
      "</div>";
    document.body.appendChild(host);
    host.querySelector("#authOwnerClose").onclick = closeWechatOwnerDialog;
    /* persistent：窗内是「合并 / 切换账号」的决策，点蒙层不关窗，只走 ✕ / Esc / 取消 */
    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      closeWechatOwnerDialog();
    });
    OWNER.host = host;
    return host;
  }

  function onWechatOwnedByOther(r) {
    stopWechat();
    openWechatOwnerDialog((r && r.owner) || {});
  }

  function openWechatOwnerDialog(owner) {
    var host = ensureWechatOwnerHost();
    var title = host.querySelector("#authOwnerTitle");
    var body = host.querySelector("#authOwnerBody");
    if (!title || !body) return;
    var o = owner || {};
    title.textContent = T("微信已绑定其它账号");
    body.innerHTML = "";
    body.appendChild(
      el(
        "div",
        "auth-hint",
        T("该微信已绑定到以下账号，请选择改用该微信登录（切换到该账号）或取消。"),
      ),
    );
    var card = el("div", "auth-hint");
    card.appendChild(el("b", "", o.nickname || o.username || T("该账号")));
    card.appendChild(el("div", "", ownerMetaText(o)));
    body.appendChild(card);
    var go = el(
      "button",
      "mini primary auth-go",
      T("改用该微信登录（切换到该账号）"),
    );
    go.type = "button";
    go.id = "authOwnerSwitch";
    go.onclick = switchToWechatOwner;
    var cancel = el("button", "mini auth-back", T("取消"));
    cancel.type = "button";
    cancel.onclick = closeWechatOwnerDialog;
    body.appendChild(go);
    body.appendChild(cancel);
    host.classList.add("on");
    host.focus();
  }

  function closeWechatOwnerDialog() {
    if (OWNER.host) OWNER.host.classList.remove("on");
  }

  /* 改用该微信登录：关闭当前绑定流程，按登录意图重新 start / poll（scene=login） */
  function switchToWechatOwner() {
    closeWechatOwnerDialog();
    closeAuthDialog();
    openAuthDialog("login", "wechat", true);
  }

  /* ---------- 手机验证码 ---------- */
  function paintSmsPane(body) {
    var phoneFld = field("手机号", "authSmsPhone", "tel", "请输入 11 位手机号", {
      maxlength: "11",
      inputmode: "numeric",
      autocomplete: "tel",
    });
    var codeFld = el("label", "auth-fld");
    codeFld.appendChild(el("span", "", T("验证码")));
    var row = el("div", "auth-code-row");
    var codeInp = document.createElement("input");
    codeInp.id = "authSmsCode";
    codeInp.maxLength = 6;
    codeInp.setAttribute("inputmode", "numeric");
    codeInp.setAttribute("autocomplete", "one-time-code");
    codeInp.placeholder = T("6 位验证码");
    var send = el("button", "mini", T("获取验证码"));
    send.type = "button";
    send.id = "authSmsSend";
    send.onclick = onSmsSend;
    row.appendChild(codeInp);
    row.appendChild(send);
    codeFld.appendChild(row);

    var err = el("div", "auth-err");
    err.id = "authSmsErr";
    err.hidden = true;
    var go = el("button", "mini primary auth-go", T("登录"));
    go.type = "button";
    go.id = "authSmsGo";
    go.onclick = onSmsLogin;

    body.appendChild(phoneFld);
    body.appendChild(codeFld);
    body.appendChild(err);
    body.appendChild(go);
    body.appendChild(
      el("div", "auth-hint", T("未注册的手机号将自动创建账号；验证码 5 分钟内有效")),
    );
    submitOnEnter(codeInp, onSmsLogin);
    submitOnEnter($id("authSmsPhone"), onSmsSend);
  }

  function startCooldown(sec) {
    AUTH.cooldown = Math.max(0, Number(sec) || 60);
    if (AUTH.cdTimer) clearInterval(AUTH.cdTimer);
    var tick = function () {
      var b = $id("authSmsSend");
      if (!b) {
        if (AUTH.cdTimer) clearInterval(AUTH.cdTimer);
        AUTH.cdTimer = null;
        return;
      }
      if (AUTH.cooldown <= 0) {
        if (AUTH.cdTimer) clearInterval(AUTH.cdTimer);
        AUTH.cdTimer = null;
        b.disabled = false;
        b.textContent = T("获取验证码");
        return;
      }
      b.disabled = true;
      b.textContent = AUTH.cooldown + T(" 秒后重发");
      AUTH.cooldown--;
    };
    tick();
    AUTH.cdTimer = setInterval(tick, 1000);
  }

  function onSmsSend() {
    var phone = String(($id("authSmsPhone") || {}).value || "").trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      showErr("authSmsErr", T("请输入正确的 11 位手机号"));
      return;
    }
    var b = $id("authSmsSend");
    if (b) {
      b.disabled = true;
      b.textContent = T("发送中…");
    }
    call("smsSend", {
      phone: phone,
      scene: AUTH.mode === "bindPhone" ? "bind" : "login",
    }).then(function (r) {
      if (r.ok) {
        showErr("authSmsErr", "");
        toast(T("验证码已发送"));
        startCooldown(Number(r.cooldown) || 60);
        var c = $id("authSmsCode");
        if (c) c.focus();
      } else {
        if (b) {
          b.disabled = false;
          b.textContent = T("获取验证码");
        }
        showErr("authSmsErr", errText(r));
      }
    });
  }

  function onSmsLogin() {
    var phone = String(($id("authSmsPhone") || {}).value || "").trim();
    var code = String(($id("authSmsCode") || {}).value || "").trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      showErr("authSmsErr", T("请输入正确的 11 位手机号"));
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      showErr("authSmsErr", T("请输入收到的验证码"));
      return;
    }
    showErr("authSmsErr", "");
    call("smsLogin", { phone: phone, code: code }).then(function (r) {
      if (r.ok) onSession(r, T("登录成功"));
      else showErr("authSmsErr", errText(r));
    });
  }

  /* ---------- 账号密码 ---------- */
  function paintPasswordPane(body) {
    var uFld = field("用户名", "authPwdUser", "text", "用户名", {
      autocomplete: "username",
    });
    var pFld = field("密码", "authPwdPass", "password", "密码", {
      autocomplete: "current-password",
    });
    var err = el("div", "auth-err");
    err.id = "authPwdErr";
    err.hidden = true;
    var go = el("button", "mini primary auth-go", T("登录"));
    go.type = "button";
    go.id = "authPwdGo";
    go.onclick = onPasswordLogin;
    body.appendChild(uFld);
    body.appendChild(pFld);
    body.appendChild(err);
    body.appendChild(go);
    body.appendChild(
      el(
        "div",
        "auth-hint",
        T("老用户可用用户名密码登录；登录后可在账户菜单绑定手机 / 微信，再解绑旧密码"),
      ),
    );
    submitOnEnter($id("authPwdPass"), onPasswordLogin);
  }

  function onPasswordLogin() {
    var username = String(($id("authPwdUser") || {}).value || "").trim();
    var password = String(($id("authPwdPass") || {}).value || "");
    if (!username) {
      showErr("authPwdErr", T("请输入用户名"));
      return;
    }
    if (!password) {
      showErr("authPwdErr", T("请输入密码"));
      return;
    }
    showErr("authPwdErr", "");
    call("password", { username: username, password: password }).then(function (r) {
      if (r.ok) onSession(r, T("登录成功"));
      else showErr("authPwdErr", errText(r));
    });
  }

  /* ---------- 绑定手机 ---------- */
  function paintBindPhonePane(body) {
    var phoneFld = field("手机号", "authSmsPhone", "tel", "请输入要绑定的手机号", {
      maxlength: "11",
      inputmode: "numeric",
      autocomplete: "tel",
    });
    var codeFld = el("label", "auth-fld");
    codeFld.appendChild(el("span", "", T("验证码")));
    var row = el("div", "auth-code-row");
    var codeInp = document.createElement("input");
    codeInp.id = "authSmsCode";
    codeInp.maxLength = 6;
    codeInp.setAttribute("inputmode", "numeric");
    codeInp.setAttribute("autocomplete", "one-time-code");
    codeInp.placeholder = T("6 位验证码");
    var send = el("button", "mini", T("获取验证码"));
    send.type = "button";
    send.id = "authSmsSend";
    send.onclick = onSmsSend;
    row.appendChild(codeInp);
    row.appendChild(send);
    codeFld.appendChild(row);

    body.appendChild(phoneFld);
    body.appendChild(codeFld);
    if (SNAP.hasPassword) {
      body.appendChild(
        field("账号密码（二次验证）", "authBindPass", "password", "请输入当前密码", {
          autocomplete: "current-password",
        }),
      );
    }
    var err = el("div", "auth-err");
    err.id = "authBindErr";
    err.hidden = true;
    var go = el("button", "mini primary auth-go", T("绑定手机号"));
    go.type = "button";
    go.onclick = onBindPhone;
    var back = el("button", "mini auth-back", T("返回"));
    back.type = "button";
    back.onclick = function () {
      openAuthDialog("login");
    };
    body.appendChild(err);
    body.appendChild(go);
    body.appendChild(back);
    body.appendChild(
      el("div", "auth-hint", T("验证码会发送到该号码，验证通过后手机号即成为登录方式")),
    );
    submitOnEnter(codeInp, onBindPhone);
  }

  function onBindPhone() {
    var phone = String(($id("authSmsPhone") || {}).value || "").trim();
    var code = String(($id("authSmsCode") || {}).value || "").trim();
    var pass = $id("authBindPass");
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      showErr("authBindErr", T("请输入正确的 11 位手机号"));
      return;
    }
    if (!code) {
      showErr("authBindErr", T("请输入收到的验证码"));
      return;
    }
    if (SNAP.hasPassword && (!pass || !pass.value)) {
      showErr("authBindErr", T("请输入账号密码完成二次验证"));
      return;
    }
    showErr("authBindErr", "");
    call("bind", {
      kind: "phone",
      phone: phone,
      code: code,
      password: pass ? pass.value : "",
    }).then(function (r) {
      if (r.ok) {
        if (r.user) applyUser(r.user);
        refresh();
        toast(T("手机号绑定成功"));
        closeAuthDialog();
      } else {
        showErr("authBindErr", errText(r));
      }
    });
  }

  /* ---------- 会话结果 ---------- */
  /* 成功口径 = 主进程落库（refresh() 后的 SNAP.signedIn），而不是上游返回的 ok：
     未生效就不提示成功、不关窗，把结果交给调用方（onChecked）决定怎么提示。
     返回 Promise<boolean>（true = 会话确实生效），便于链式判断。 */
  function onSession(r, okMsg, onChecked) {
    if (r && r.user) applyUser(r.user);
    return refresh().then(function () {
      var ok = SNAP.signedIn;
      if (ok) {
        toast(okMsg || T("登录成功"));
        closeAuthDialog();
      }
      if (typeof onChecked === "function") onChecked(ok);
      return ok;
    });
  }

  /* ---------- 退出登录 ---------- */
  function doLogout() {
    var ask =
      typeof confirmDialog === "function"
        ? confirmDialog(T("确定要退出登录吗？"), {
            okText: T("退出登录"),
            cancelText: T("取消"),
            danger: true,
          })
        : Promise.resolve(true);
    ask.then(function (ok) {
      if (!ok) return;
      call("logout").then(function (r) {
        closeAccountMenu();
        if (r.ok) {
          applyUser(null);
          toast(T("已退出登录"));
        } else {
          toast(errText(r), "warn");
        }
        refresh();
      });
    });
  }

  /* ───────────────────────── 修改昵称 ───────────────────────── */
  var NICK = { host: null };

  function ensureNickHost() {
    if (NICK.host) return NICK.host;
    var host = el("div", "mt-dialog auth-dlg auth-nick-dlg");
    host.id = "authNickDlg";
    host.tabIndex = -1;
    host.innerHTML =
      '<div class="mt-dialog-box auth-box" role="dialog" aria-modal="true" aria-labelledby="authNickTitle">' +
      '<div class="mt-dialog-head auth-head">' +
      '<b id="authNickTitle"></b>' +
      '<button type="button" class="mini node-guide-x" id="authNickClose" title="' +
      T("关闭") +
      '">✕</button>' +
      "</div>" +
      '<div class="mt-dialog-body auth-body" id="authNickBody"></div>' +
      "</div>";
    document.body.appendChild(host);
    host.querySelector("#authNickClose").onclick = function () {
      closeNickDialog();
    };
    /* persistent：昵称是待提交的输入，点蒙层不关窗，只走 ✕ / Esc / 取消 */
    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      closeNickDialog();
    });
    NICK.host = host;
    return host;
  }

  function openNickDialog() {
    var host = ensureNickHost();
    closeAccountMenu();
    try {
      if (typeof closeApprovalsPanel === "function") closeApprovalsPanel();
    } catch (_) {}
    try {
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept(null);
    } catch (_) {}
    var title = host.querySelector("#authNickTitle");
    var body = host.querySelector("#authNickBody");
    if (!title || !body) return;
    title.textContent = T("修改昵称");
    body.innerHTML = "";
    body.appendChild(
      field("昵称（1-32 位）", "authNickInput", "text", "请输入昵称", {
        maxlength: "32",
        autocomplete: "nickname",
      }),
    );
    var err = el("div", "auth-err");
    err.id = "authNickErr";
    err.hidden = true;
    var go = el("button", "mini primary auth-go", T("保存"));
    go.type = "button";
    go.onclick = onNickSave;
    var cancel = el("button", "mini auth-back", T("取消"));
    cancel.type = "button";
    cancel.onclick = function () {
      closeNickDialog();
    };
    body.appendChild(err);
    body.appendChild(go);
    body.appendChild(cancel);
    body.appendChild(
      el("div", "auth-hint", T("昵称会显示在账户菜单与论坛等处")),
    );
    host.classList.add("on");
    host.focus();
    var inp = $id("authNickInput");
    if (inp) {
      inp.value = (SNAP.user && (SNAP.user.nickname || SNAP.user.username)) || "";
      submitOnEnter(inp, onNickSave);
      inp.focus();
      inp.select();
    }
  }

  function closeNickDialog() {
    if (NICK.host) NICK.host.classList.remove("on");
  }

  function onNickSave() {
    var inp = $id("authNickInput");
    var name = String((inp && inp.value) || "").trim();
    if (!name || name.length > 32) {
      showErr("authNickErr", T("昵称长度需 1-32 位"));
      return;
    }
    var a = bridge();
    var m = a && typeof a.authSetNickname === "function" ? a.authSetNickname : null;
    if (!m) {
      showErr("authNickErr", T("登录服务未就绪（主进程账户模块尚未接入）"));
      return;
    }
    showErr("authNickErr", "");
    Promise.resolve()
      .then(function () {
        return m({ nickname: name });
      })
      .then(function (r) {
        r = r && typeof r === "object" ? r : { ok: !!r };
        if (!r.ok) {
          showErr("authNickErr", errText(r));
          return;
        }
        if (r.user) applyUser(r.user);
        refresh();
        toast(T("昵称已更新"));
        closeNickDialog();
      })
      .catch(function (e) {
        showErr("authNickErr", (e && e.message) || T("与主进程通信失败"));
      });
  }

  /* ───────────────────────── 初始化 ───────────────────────── */
  var inited = false;
  function init() {
    if (inited) return;
    inited = true;
    var btn = $id("btnAccount");
    if (btn) {
      /* 登录方式全关（METHOD_ON）时入口退回隐藏；至少开一项即显示 */
      btn.hidden = !firstEnabledTab();
      btn.onclick = toggleAccountMenu;
    }
    var a = bridge();
    if (a) {
      var on = a.onAuthChanged || a.onAccountChanged;
      if (typeof on === "function") {
        try {
          on(function () {
            refresh();
          });
        } catch (_) {}
      }
      /* 与旧论坛 / 工坊账户态保持同步（同一账号打通后主进程会推这个事件） */
      if (typeof a.onForumAuthChanged === "function") {
        try {
          a.onForumAuthChanged(function () {
            refresh();
          });
        } catch (_) {}
      }
    }
    window.addEventListener("resize", positionMenu);
    /* 互斥：点别的顶栏面板时收掉账户菜单（不是「点外部即关」——只认顶栏触发区） */
    document.addEventListener(
      "click",
      function (ev) {
        if (!menuOpen()) return;
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest("#accountMenu") || t.closest("#btnAccount")) return;
        if (t.closest(".topbar")) closeAccountMenu();
      },
      true,
    );
    paintEntry();
    refresh();
  }

  /* ───────────────────────── 对外接口 ───────────────────────── */
  var login = {
    password: function (p) {
      return call("password", p);
    },
    sms: {
      send: function (p) {
        return call("smsSend", p);
      },
      verify: function (p) {
        return call("smsLogin", p);
      },
    },
    wechat: {
      start: function (p) {
        return call("wechatStart", p);
      },
      poll: function (p) {
        return call("wechatPoll", p);
      },
    },
  };

  window.MTNodeAuth = {
    state: state,
    refresh: refresh,
    login: login,
    bind: function (kind, payload) {
      return call("bind", Object.assign({ kind: kind }, payload || {}));
    },
    unbind: function (kind, payload) {
      return call("unbind", Object.assign({ kind: kind }, payload || {}));
    },
    logout: function () {
      return call("logout");
    },
    onChange: onChange,
    /* 当前对界面开放的登录方式（METHOD_ON 快照）：{ sms, wechat, password } */
    methods: function () {
      return Object.assign({}, METHOD_ON);
    },
    open: function (tab) {
      openAuthDialog("login", tab);
    },
    close: closeAuthDialog,
    paint: paintEntry,
    /* 对话框 / 菜单控制（内部 UI 复用） */
    openBind: function (kind) {
      openAuthDialog(kind === "wechat" ? "bindWechat" : "bindPhone");
    },
    closeMenu: closeAccountMenu,
  };

  /* 最后再接管界面：此时 window.MTNodeAuth 已就位 */
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
