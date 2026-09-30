/* 账户充值（钱包）：余额展示 + 支付宝扫码充值 + 订单/流水查看。
 *
 * 口径（与云端 store-saas 一致，详见 docs/recharge-design.md）：
 *   · 金额一律「元」（4 位小数）：服务端只下发 / 只接收元，前端不做分↔元换算，也不做算术决策。
 *   · 入口只对白名单账号显示（测试期 = ms2308）；云端 MTNODE_RECHARGE_USERS 是同一份口径，
 *     两边都放开才算正式上线。服务端另有 403 RECHARGE_NOT_OPEN 兜底，前端藏入口只是体验层。
 *   · 下单成功才展示二维码（服务端先向支付宝预下单、再落本地订单），轮询只查自己的订单。
 *   · 弹窗 persistent + 可最小化；关闭 / 被别的弹窗顶掉后，轮询必须停（用代次 gen + isConnected 双保险）。
 *
 * 依赖：window.api.storeRequest（主进程统一带 Bearer）、app.js 的 openOverlay、I18n。
 */
(function () {
  "use strict";

  var VISIBLE_USERS = ["ms2308"];
  var FALLBACK_TIERS = [10, 30, 50, 100, 500];
  var MIN_YUAN = 1;
  var MAX_YUAN = 1000;
  var POLL_MS = 2000;

  /* 文案一律走 I18n.t；带变量的用 {占位} 键（第二参），不要拼接——英文语序不同会散架。 */
  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  /* 金额一律「元」（4 位小数）：服务端只下发 / 只接收元，这里不做分↔元换算。 */
  function money(yuan) {
    return "¥" + Number(yuan || 0).toFixed(4);
  }
  function visibleFor(u) {
    if (!u) return false;
    var name = String(u.username || "").toLowerCase();
    return !!name && VISIBLE_USERS.indexOf(name) >= 0;
  }
  function balanceOf(u) {
    var n = Number(u && u.balanceYuan);
    return isFinite(n) ? n : 0;
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

  var CODE_TEXT = {
    ALIPAY_UNAVAILABLE: "支付通道尚未配置，暂时无法充值",
    RECHARGE_NOT_OPEN: "充值功能尚未对该账号开放",
    INVALID_AMOUNT: "金额无效",
    TOO_MANY_PENDING: "未支付订单过多，请先完成或等其过期",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    ORDER_NOT_FOUND: "订单不存在或已失效",
    UNAUTHORIZED: "请先登录",
    ALIPAY_ERROR: "支付宝接口异常，请稍后重试",
  };

  var ST = {
    cfg: null,
    balanceYuan: 0,
    tiers: FALLBACK_TIERS.slice(),
    pickedYuan: 0,
    order: null,
    orders: [],
    ledger: [],
    gen: 0,
    timer: 0,
    busy: false,
    root: null,
    // 已经自动弹过浏览器收银台的订单号：每笔单只自动开一次（重绘 / 轮询不重复弹窗）。
    autoOpened: "",
  };

  function api(method, path, json) {
    return window.api.storeRequest({ method: method, path: path, json: json });
  }

  function errText(r) {
    var code = r && r.data && r.data.code;
    if (code && CODE_TEXT[code]) return T(CODE_TEXT[code]);
    var raw = r && r.data && r.data.error;
    if (raw) return String(raw);
    if (r && r.status) return T("请求失败（HTTP {code}）", { code: String(r.status) });
    return T("网络请求失败");
  }

  /* 支付完成后同步账号快照（余额）：主进程 /api/me → 落盘 → 重绘账号菜单。 */
  function refreshUser() {
    return Promise.resolve()
      .then(function () {
        return window.api && window.api.authMe ? window.api.authMe() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function () {
        if (window.MTNodeAuth && window.MTNodeAuth.refresh) return window.MTNodeAuth.refresh();
      })
      .catch(function () {
        /* 刷新失败不影响充值结果本身，余额下次打开会重新拉 */
      });
  }

  function stopPoll() {
    if (ST.timer) {
      clearTimeout(ST.timer);
      ST.timer = 0;
    }
  }

  function dialogAlive() {
    return !!(ST.root && ST.root.isConnected && ST.gen === liveGen);
  }
  var liveGen = 0;

  /* ---------- 数据加载 ---------- */

  function loadConfig() {
    return api("GET", "/api/wallet/config")
      .then(function (r) {
        if (r && r.ok && r.data) {
          ST.cfg = r.data;
          if (Array.isArray(r.data.tiersYuan) && r.data.tiersYuan.length) ST.tiers = r.data.tiersYuan.slice();
          if (Number(r.data.minYuan)) MIN_YUAN = Number(r.data.minYuan);
          if (Number(r.data.maxYuan)) MAX_YUAN = Number(r.data.maxYuan);
          /* 界面是在配置回来**之前**用兜底值画的：档位、金额上下限、主按钮文案都要按服务端
             真值重画一次，否则 env 调过限额（例如验收时把下限降到 0.01 元）时，输入框的 min/max
             与「¥1.0000 – ¥1000.0000」提示还停在兜底值，与实际校验口径不一致。 */
          paintTiers();
          paintCustomRange();
        }
      })
      .catch(function () {
        ST.cfg = null;
      });
  }

  function loadSummary() {
    return api("GET", "/api/wallet/summary?limit=10")
      .then(function (r) {
        if (!r || !r.ok || !r.data) throw r;
        var w = r.data.wallet || {};
        ST.balanceYuan = Number(w.balanceYuan || 0);
        ST.orders = Array.isArray(w.orders) ? w.orders : [];
        ST.ledger = Array.isArray(w.ledger) ? w.ledger : [];
        if (r.data.user) {
          var b = balanceOf(r.data.user);
          if (b) ST.balanceYuan = b;
        }
        return true;
      })
      .catch(function (e) {
        setNotice(errText(e), "err");
        return false;
      });
  }

  /* ---------- 界面 ---------- */

  function setNotice(text, kind) {
    if (!dialogAlive()) return;
    var n = ST.root && ST.root.querySelector("#wlNotice");
    if (!n) return;
    n.textContent = text || "";
    n.className = "wl-notice" + (kind ? " " + kind : "") + (text ? "" : " hidden");
  }

  function paintBalance() {
    if (!dialogAlive()) return;
    var v = ST.root.querySelector("#wlBalance");
    if (v) v.textContent = money(ST.balanceYuan);
  }

  function paintTiers() {
    if (!dialogAlive()) return;
    var box = ST.root.querySelector("#wlTiers");
    if (!box) return;
    box.textContent = "";
    ST.tiers.forEach(function (yuan) {
      var b = el("button", "wl-tier" + (ST.pickedYuan === yuan ? " on" : ""), money(yuan));
      b.type = "button";
      b.onclick = function () {
        ST.pickedYuan = yuan;
        var inp = ST.root.querySelector("#wlCustom");
        if (inp) inp.value = "";
        paintTiers();
      };
      box.appendChild(b);
    });
    var custom = el("button", "wl-tier" + (ST.pickedYuan === 0 ? " on" : ""), T("自定义"));
    custom.type = "button";
    custom.onclick = function () {
      ST.pickedYuan = 0;
      paintTiers();
      var inp = ST.root.querySelector("#wlCustom");
      if (inp) inp.focus();
    };
    box.appendChild(custom);
  }

  /* 金额上下限按服务端真值刷到输入框与提示上（配置回来之前用的是兜底值）。 */
  function paintCustomRange() {
    if (!dialogAlive()) return;
    var inp = ST.root.querySelector("#wlCustom");
    if (inp) {
      inp.min = String(MIN_YUAN);
      inp.max = String(MAX_YUAN);
    }
    var hint = ST.root.querySelector("#wlRange");
    if (hint) hint.textContent = money(MIN_YUAN) + " – " + money(MAX_YUAN);
  }

  function pickedYuan() {
    if (ST.pickedYuan > 0) return ST.pickedYuan;
    var inp = ST.root && ST.root.querySelector("#wlCustom");
    var v = inp ? Number(inp.value) : 0;
    if (!isFinite(v) || v <= 0) return 0;
    return Math.round(v * 1e4) / 1e4;
  }

  function paintQr() {
    if (!dialogAlive()) return;
    var panel = ST.root.querySelector("#wlQr");
    if (!panel) return;
    panel.textContent = "";
    var o = ST.order;
    if (!o) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    if (o.status === "paid") {
      panel.appendChild(el("div", "wl-qr-ok", "✓ " + T("充值成功")));
      panel.appendChild(
        el("div", "wl-qr-sub", T("{amount} 已到账", { amount: money(o.paidAmountYuan || o.amountYuan) })),
      );
      panel.appendChild(el("div", "wl-qr-sub muted", T("订单号：{id}", { id: o.id })));
      return;
    }
    if (o.status === "expired" || o.status === "closed") {
      panel.appendChild(el("div", "wl-qr-bad", T("订单已过期")));
      panel.appendChild(el("div", "wl-qr-sub muted", T("请重新发起充值")));
      return;
    }
    if (o.status === "paid_mismatch") {
      panel.appendChild(el("div", "wl-qr-bad", T("实付金额与订单不符")));
      panel.appendChild(el("div", "wl-qr-sub muted", T("已记录，请联系管理员核对后处理")));
      return;
    }
    /* 左栏按通道分两种画法（由订单实际带的字段决定，重开旧单也对）：
       · payUrl    电脑网站支付 → 「打开支付宝收银台」按钮，用系统浏览器付（页面自带二维码可手机扫）
       · qrDataUrl 当面付        → 窗内直接显示服务端自绘的付款二维码 */
    var left = el("div", "wl-qr-left");
    if (o.payUrl) {
      var go = el("button", "wl-btn primary wl-pay-open", T("打开支付宝收银台"));
      go.type = "button";
      go.onclick = function () { openPayUrl(o.payUrl); };
      left.appendChild(go);
      left.appendChild(el("div", "wl-qr-amount", money(o.amountYuan)));
      left.appendChild(el("div", "wl-pay-hint muted", T("会在系统浏览器里打开支付宝收银台，可用手机支付宝扫码付款")));
      if (ST.autoOpened !== o.id) {
        // 用户刚点了「充值」，直接把收银台打开（每笔单只自动开一次，重绘不重复弹浏览器）。
        ST.autoOpened = o.id;
        openPayUrl(o.payUrl);
      }
    } else {
      var img = el("img", "wl-qr-img");
      img.alt = T("支付宝付款码");
      if (o.qrDataUrl) img.src = o.qrDataUrl;
      left.appendChild(img);
      left.appendChild(el("div", "wl-qr-amount", money(o.amountYuan)));
    }
    panel.appendChild(left);

    var right = el("div", "wl-qr-right");
    right.appendChild(el("div", "wl-qr-title", o.payUrl ? T("在浏览器里完成支付") : T("用支付宝扫码付款")));
    var cd = el("div", "wl-qr-count", "");
    cd.id = "wlCountdown";
    right.appendChild(cd);
    right.appendChild(el("div", "wl-qr-sub muted", T("订单号：{id}", { id: o.id })));
    var done = el("button", "wl-btn", T("我已完成支付"));
    done.type = "button";
    done.onclick = manualRefresh;
    right.appendChild(done);
    if (o.payUrl) {
      var again = el("button", "wl-btn ghost", T("重新打开收银台"));
      again.type = "button";
      again.onclick = function () { openPayUrl(o.payUrl); };
      right.appendChild(again);
    }
    var cancel = el("button", "wl-btn ghost", T("放弃本单"));
    cancel.type = "button";
    cancel.onclick = function () {
      stopPoll();
      ST.order = null;
      ST.autoOpened = "";
      paintQr();
      setBusy(false);
    };
    right.appendChild(cancel);
    panel.appendChild(right);
    paintCountdown();
  }

  /** 用系统浏览器打开收银台（渲染层没有 shell 权限，走 preload 暴露的 openExternal）。 */
  function openPayUrl(u) {
    var url = String(u || "");
    if (!url) return;
    if (window.api && typeof window.api.openExternal === "function") {
      try {
        window.api.openExternal(url);
        return;
      } catch (e) { /* 落到下面的提示 */ }
    }
    setNotice(T("无法自动打开浏览器，请手动访问：{url}", { url: url }), "err");
  }

  function paintCountdown() {
    if (!dialogAlive()) return;
    var n = ST.root.querySelector("#wlCountdown");
    if (!n || !ST.order) return;
    var left = Math.max(0, Math.ceil((Number(ST.order.expiresAt || 0) - Date.now()) / 1000));
    var m = Math.floor(left / 60);
    var s = left % 60;
    n.textContent = T("剩余 {t}", { t: m + ":" + String(s).padStart(2, "0") });
    n.className = "wl-qr-count" + (left <= 60 ? " warn" : "");
    if (left <= 0 && ST.order.status === "pending") {
      ST.order.status = "expired";
      stopPoll();
      paintQr();
      setBusy(false);
    }
  }

  function paintHistory() {
    if (!dialogAlive()) return;
    var box = ST.root.querySelector("#wlHistory");
    if (!box) return;
    box.textContent = "";
    if (!ST.orders.length && !ST.ledger.length) {
      box.appendChild(el("div", "muted", T("暂无充值记录")));
      return;
    }
    if (ST.orders.length) {
      box.appendChild(el("div", "wl-h-title", T("最近订单")));
      var t = el("table", "wl-table");
      var head = el("tr");
      [T("时间"), T("金额"), T("状态"), T("订单号")].forEach(function (h) {
        head.appendChild(el("th", "", h));
      });
      t.appendChild(head);
      var ST_TEXT = {
        pending: T("待支付"),
        paid: T("已支付"),
        partial_refunded: T("部分退款"),
        refunded: T("已退款"),
        expired: T("已过期"),
        closed: T("已关单"),
        paid_mismatch: T("金额不符"),
      };
      ST.orders.slice(0, 8).forEach(function (o) {
        var tr = el("tr");
        tr.appendChild(el("td", "", tsText(o.createdAt)));
        tr.appendChild(el("td", "num", money(o.amountYuan)));
        tr.appendChild(el("td", "st st-" + o.status, ST_TEXT[o.status] || o.status));
        tr.appendChild(el("td", "mono", o.id));
        t.appendChild(tr);
      });
      box.appendChild(t);
    }
    if (ST.ledger.length) {
      box.appendChild(el("div", "wl-h-title", T("余额变动")));
      var t2 = el("table", "wl-table");
      var h2 = el("tr");
      [T("时间"), T("类型"), T("变动"), T("变动后余额")].forEach(function (h) {
        h2.appendChild(el("th", "", h));
      });
      t2.appendChild(h2);
      var TY = { recharge: T("充值入账"), refund: T("退款"), adjust: T("人工调账"), mismatch: T("金额不符") };
      ST.ledger.slice(0, 8).forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "", tsText(e.at)));
        tr.appendChild(el("td", "", TY[e.type] || e.type));
        /* 负数要显示成 -¥4.00 而不是 ¥-4.00：符号在货币符号外面才读得顺 */
        var dv = Number(e.deltaYuan) || 0;
        var d = el("td", "num " + (dv >= 0 ? "pos" : "neg"));
        d.textContent = (dv >= 0 ? "+" : "-") + money(Math.abs(dv));
        tr.appendChild(d);
        tr.appendChild(el("td", "num", money(e.balanceAfterYuan)));
        t2.appendChild(tr);
      });
      box.appendChild(t2);
    }
  }

  /** 主按钮文案随通道变：page = 去浏览器收银台付款 · precreate = 窗内出二维码。 */
  function payLabel() {
    var ch = ST.cfg && ST.cfg.channel;
    return ch === "alipay_f2f" ? T("生成支付宝付款码") : T("去支付宝付款");
  }

  function setBusy(on) {
    ST.busy = !!on;
    if (!dialogAlive()) return;
    var b = ST.root.querySelector("#wlPay");
    if (b) {
      b.disabled = !!on || !payEnabled();
      b.textContent = on ? T("处理中…") : payLabel();
    }
  }

  function payEnabled() {
    if (!ST.cfg) return true; // 配置还没拉到时不禁用，点了才知道结果
    return !!ST.cfg.payConfigured;
  }

  /* ---------- 动作 ---------- */

  function createOrder() {
    if (ST.busy) return;
    var yuan = pickedYuan();
    if (!yuan) {
      setNotice(T("请选择或输入充值金额"), "err");
      return;
    }
    if (yuan < MIN_YUAN || yuan > MAX_YUAN) {
      setNotice(
        T("充值金额需在 {min} – {max} 之间", { min: money(MIN_YUAN), max: money(MAX_YUAN) }),
        "err",
      );
      return;
    }
    setBusy(true);
    setNotice("");
    api("POST", "/api/wallet/recharge/create", { amountYuan: yuan })
      .then(function (r) {
        if (!dialogAlive()) return;
        if (!r || !r.ok || !r.data) throw r;
        ST.order = r.data.order;
        paintQr();
        startPoll();
      })
      .catch(function (e) {
        if (!dialogAlive()) return;
        setNotice(errText(e), "err");
      })
      .then(function () {
        if (dialogAlive()) setBusy(false);
      });
  }

  function startPoll() {
    stopPoll();
    var gen = ST.gen;
    var step = function () {
      if (!dialogAlive() || gen !== ST.gen) return;
      /* 本次定时器已经触发：必须先把句柄清零，否则末尾的 `!ST.timer` 判定会以为「还有一个
         定时器在排队」而不再续期 —— 轮询链只跑一次就断，付了钱也永远等不到自动入账
         （只能靠用户手点「我已完成支付」）。这个 bug 由 Electron 实渲染夹具抓出来。 */
      ST.timer = 0;
      var o = ST.order;
      if (!o || o.status !== "pending") return;
      api("GET", "/api/wallet/recharge/order?id=" + encodeURIComponent(o.id))
        .then(function (r) {
          if (!dialogAlive() || gen !== ST.gen) return;
          if (r && r.ok && r.data && r.data.order) {
            var next = r.data.order;
            var was = ST.order.status;
            ST.order = next;
            if (next.status !== was) paintQr();
            paintCountdown();
            if (next.status === "paid") {
              stopPoll();
              onPaid();
              return;
            }
            if (next.status === "expired" || next.status === "closed" || next.status === "paid_mismatch") {
              stopPoll();
              setBusy(false);
              return;
            }
          }
        })
        .catch(function () {
          /* 单次轮询失败不提示、不中断：下一轮继续 */
        })
        .then(function () {
          if (dialogAlive() && gen === ST.gen && ST.order && ST.order.status === "pending" && !ST.timer) {
            ST.timer = setTimeout(step, POLL_MS);
          }
        });
    };
    ST.timer = setTimeout(step, POLL_MS);
  }

  function onPaid() {
    setNotice(T("充值成功，余额已更新"), "ok");
    loadSummary().then(function () {
      paintBalance();
      paintHistory();
    });
    refreshUser();
    /* 充值到账 → 中转服务那张只读卡当场出现 / 恢复可用（renderer/app-relay.js）：
       余额从 0 变正时服务端才开始下发模型清单，这里强制拉一次，不等下次登录。 */
    try {
      if (window.MtRelay && window.MtRelay.sync) window.MtRelay.sync({ force: true });
    } catch (e) {}
  }

  function manualRefresh() {
    if (!ST.order) return;
    setBusy(true);
    api("POST", "/api/wallet/recharge/refresh", { id: ST.order.id })
      .then(function (r) {
        if (!dialogAlive()) return;
        if (!r || !r.ok) throw r;
        var d = r.data || {};
        if (d.order) ST.order = d.order;
        paintQr();
        if (d.paid) {
          stopPoll();
          onPaid();
        } else if (d.closed) {
          stopPoll();
        } else {
          setNotice(T("支付宝侧还未收到款项，请稍等或重新扫码"), "");
        }
      })
      .catch(function (e) {
        if (dialogAlive()) setNotice(errText(e), "err");
      })
      .then(function () {
        if (dialogAlive()) setBusy(false);
      });
  }

  /* ---------- 打开对话框 ---------- */

  function openWallet() {
    if (!window.api || !window.api.storeRequest) {
      window.alert(T("账户服务未就绪"));
      return;
    }
    stopPoll();
    liveGen = (liveGen + 1) % 100000;
    ST.gen = liveGen;
    ST.order = null;
    ST.pickedYuan = (ST.tiers[0] || 10);

    openOverlay(T("账户充值"), { persistent: true, min: true });
    var body = document.getElementById("ovBody");
    var foot = document.getElementById("ovFoot");
    if (!body) return;
    body.innerHTML = "";
    if (foot) foot.innerHTML = "";

    var root = el("div", "wallet-root");
    ST.root = root;
    body.appendChild(root);

    /* 余额 */
    var bal = el("div", "wl-balance");
    bal.appendChild(el("div", "wl-k", T("当前余额")));
    var bv = el("div", "wl-v", "—");
    bv.id = "wlBalance";
    bal.appendChild(bv);
    var rb = el("button", "wl-btn ghost sm", T("刷新"));
    rb.type = "button";
    rb.onclick = function () {
      loadSummary().then(function () {
        paintBalance();
        paintHistory();
      });
      refreshUser();
    };
    bal.appendChild(rb);
    root.appendChild(bal);

    /* 提示条 */
    var notice = el("div", "wl-notice hidden");
    notice.id = "wlNotice";
    root.appendChild(notice);

    /* 金额选择 */
    var pick = el("div", "wl-pick");
    pick.appendChild(el("div", "wl-k", T("充值金额")));
    var tiers = el("div", "wl-tiers");
    tiers.id = "wlTiers";
    pick.appendChild(tiers);
    var custom = el("div", "wl-custom");
    var inp = el("input");
    inp.id = "wlCustom";
    inp.type = "number";
    inp.min = String(MIN_YUAN);
    inp.max = String(MAX_YUAN);
    inp.step = "0.01";
    inp.placeholder = T("自定义金额（元）");
    inp.addEventListener("input", function () {
      ST.pickedYuan = 0;
      paintTiers();
      setNotice("");
    });
    custom.appendChild(inp);
    var range = el("span", "wl-hint", money(MIN_YUAN) + " – " + money(MAX_YUAN));
    range.id = "wlRange";
    custom.appendChild(range);
    pick.appendChild(custom);
    var pay = el("button", "wl-btn primary", payLabel());
    pay.id = "wlPay";
    pay.type = "button";
    pay.onclick = createOrder;
    pick.appendChild(pay);
    root.appendChild(pick);

    /* 二维码区 */
    var qr = el("div", "wl-qr hidden");
    qr.id = "wlQr";
    root.appendChild(qr);

    /* 历史 */
    var hist = el("div", "wl-history");
    hist.id = "wlHistory";
    root.appendChild(hist);

    /* 底部 */
    if (foot) {
      var tip = el("div", "wl-foot-tip muted", T("充值到账后可在余额中查看；如长时间未到账，请用「我已完成支付」核对或联系管理员。"));
      foot.appendChild(tip);
      var close = el("button", "wl-btn", T("关闭"));
      close.type = "button";
      close.onclick = function () {
        stopPoll();
        liveGen++;
        closeOverlay();
      };
      foot.appendChild(close);
    }

    paintTiers();
    setBusy(false);
    loadConfig().then(function () {
      if (!dialogAlive()) return;
      if (ST.cfg && !ST.cfg.payConfigured) {
        setNotice(T("支付通道尚未配置，暂时无法充值"), "err");
      }
      setBusy(false);
    });
    loadSummary().then(function () {
      paintBalance();
      paintHistory();
    });
  }

  /* 账号菜单里的余额行由 app-auth.js 调用（只在白名单账号显示）。 */
  function balanceText(u) {
    return T("余额：{amount}", { amount: money(balanceOf(u)) });
  }

  window.MtWallet = {
    visibleFor: visibleFor,
    money: money,
    balanceOf: balanceOf,
    balanceText: balanceText,
    open: openWallet,
    refreshUser: refreshUser,
    state: function () {
      return { balanceYuan: ST.balanceYuan, config: ST.cfg };
    },
  };
})();
