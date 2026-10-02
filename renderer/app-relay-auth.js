/* MTNode 中转服务 · 凭据提示 —— 自包含新模块，全局 window.MtRelayAuth（+ mtRelayAuthNotice）
 *
 * 它解决什么：中转站（store-saas/relay.mjs）在「没带凭据 / 凭据已失效」时回 401，文案是
 * 「缺少或已失效的中转 Key」—— 用户看到的第一反应是「去提供商里填 Key」，而中转卡是**只读**的，
 * 根本不让填，于是反复撞同一个错。所以凭据失效必须由客户端主动说清并给出动作：
 *   · 主进程识别到中转链路 401（main.js 的 relayAuthFailed：清本机凭据 + 播 authChanged）；
 *   · 这里做两件事：弹一条**可点**的提示（点了直接开登录窗），并在界面顶部留一条常驻横幅
 *     （凭据解不开 / 存不住、票快到期时亮）——避免用户「看起来还登录着」却一直 401。
 *     「登录着但本机还没有独立中转票」不再亮横幅：那张票由客户端自己领，只是过渡态。
 *
 * 事实来源：主进程的 relay:keyInfo（relayKeyInfo()）—— 只回 signedIn / hasRelayKey /
 * expiresAt / renewDue 与**打码**凭据，明文凭据永远不出主进程。本模块不读任何存储。
 *
 * 口径：
 *   · 只认中转链路（别的服务商 401 = Key 填错，与登录态无关，一律不动）；
 *   · 动作只有两个：重新登录（openAuthDialog）与收起；
 *   · 文案走 I18n（中英词条在 renderer/i18n.js），不硬编码界面语言。
 */
(function () {
  "use strict";

  var BAR_ID = "relayAuthBar";
  var firedAt = 0;
  var hardFail = false; /* 主进程报过「凭据失效」：此后的横幅不被后续判定收掉 */
  var last = null; /* 最近一次 relay:keyInfo 结果（供自检 / 别处读） */

  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }

  function fmtTs(ms) {
    var d = new Date(Number(ms) || 0);
    if (!Number(ms)) return "—";
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      "-" +
      p(d.getMonth() + 1) +
      "-" +
      p(d.getDate()) +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes())
    );
  }

  function openLogin() {
    if (typeof openAuthDialog === "function") openAuthDialog("login");
  }

  /* 可点提示：沿用 #toastBox 的观感，但自己带一个动作按钮（toast() 是纯文本、不吃点击）。 */
  function noticeToast() {
    var box = document.getElementById("toastBox");
    if (!box) return null;
    var d = document.createElement("div");
    d.className = "toast relay-auth-toast";
    var txt = document.createElement("span");
    txt.textContent = T("登录已失效：中转服务需要重新登录一次（本机凭据已自动清理）");
    d.appendChild(txt);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = T("重新登录");
    btn.addEventListener("click", function () {
      d.remove();
      openLogin();
    });
    d.appendChild(btn);
    box.appendChild(d);
    setTimeout(function () {
      d.remove();
    }, 15000);
    return d;
  }

  /* 顶部常驻横幅：点「重新登录」去登录，点 ✕ 收起（收起只到下一次状态变化为止）。 */
  function bar() {
    var el = document.getElementById(BAR_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = BAR_ID;
    el.className = "relay-auth-bar";
    el.hidden = true;
    var msg = document.createElement("span");
    msg.className = "rab-msg";
    el.appendChild(msg);
    var go = document.createElement("button");
    go.type = "button";
    go.className = "rab-btn";
    go.textContent = T("重新登录");
    go.addEventListener("click", openLogin);
    el.appendChild(go);
    var close = document.createElement("button");
    close.type = "button";
    close.className = "rab-close";
    close.setAttribute("aria-label", T("关闭"));
    close.textContent = "✕";
    close.addEventListener("click", function () {
      el.hidden = true;
    });
    el.appendChild(close);
    document.body.appendChild(el);
    return el;
  }

  function showBar(text, reason) {
    var el = bar();
    var msg = el.querySelector(".rab-msg");
    if (msg) msg.textContent = text;
    el.dataset.reason = String(reason || "");
    el.hidden = false;
  }

  /** 中转凭据出问题了（主进程识别到中转 401）：弹一条可点提示 + 亮出横幅。 */
  function mtRelayAuthNotice() {
    var now = Date.now();
    /* 一次失效只提示一次（同一波多个请求同时 401 时不刷屏） */
    if (now - firedAt < 3000) return;
    firedAt = now;
    hardFail = true;
    noticeToast();
    showBar(
      T("中转服务登录已失效：请重新登录一次（客户端会自动领取新的中转 Key，无需手填）"),
      "failed",
    );
  }

  function render(info) {
    last = info || null;
    if (hardFail) return;
    var i = info || {};
    var el = document.getElementById(BAR_ID);
    if (!i.signedIn) {
      /* 凭据文件在手却解不开（换机 / 换了 Windows 账号 / 系统加密上下文变了）：
         此时「没登录」是**自愈后的结果**（解不开的文件已被主进程隔离留档），
         要给的是「重登一次就好」，不是含糊的「没有凭据」——否则用户以为按提示重登没用。 */
      if (i.readIssue === "decrypt_failed" || i.readIssue === "encryption_unavailable") {
        showBar(
          T(
            "本机的登录凭据读不出来（已留档并清理）：请重新登录一次 MTNode 账号，登录后会自动领取中转凭据",
          ),
          "broken",
        );
        return;
      }
      if (i.readIssue === "write_unverified") {
        showBar(
          T(
            "本机保存登录凭据失败（系统加密写得出读不回来）：请重新登录一次；若仍失败请在「设置 · 提供商」里刷新中转清单",
          ),
          "broken",
        );
        return;
      }
      if (el && el.dataset.reason !== "failed") el.hidden = true;
      return;
    }
    /* 「登录着但本机还没有独立中转票」（老凭据 / 刚登录还没领到）**不亮横幅**：
       这张票由客户端自己领（登录走完 signedIn() 就领一次，启动与打开设置时
       MtRelay.syncIfStale 还会按需续），属于一两秒的过渡态，提示出来只会让用户
       以为「按提示重登了也没用」。真在这一小段里撞上中转 401，
       mtRelayAuthNotice() 的「登录已失效」提示 + 常驻横幅仍会亮并给「重新登录」按钮。 */
    if (i.renewDue) {
      showBar(
        T("中转服务凭据即将到期：重新登录一次即可领取新的凭据"),
        "due",
      );
      return;
    }
    if (el && el.dataset.reason !== "failed") el.hidden = true;
  }

  /** 按主进程的凭据状态刷新横幅（登录态变化 / 启动 / 领取到新票后都调它）。 */
  function refresh() {
    if (!window.api || typeof window.api.relayKeyInfo !== "function") return Promise.resolve(null);
    return Promise.resolve(window.api.relayKeyInfo()).then(
      function (info) {
        render(info);
        return info;
      },
      function () {
        return null;
      },
    );
  }

  /** 登录走完（拿到独立票）后解除「刚失效」的硬口径，让横幅按新状态重算。
   *  这里**必须顺手去领一次票**（MtRelay.syncIfStale → 缺独立票时强制同步一次）：
   *  只 refresh() 等于让用户干等 —— 用户重登了，票却要等下一次打开设置 / 下次登录才去领，
   *  这段过渡期里一切中转请求都会撞 401（横幅此前就是为此亮的，现已照需求去掉横幅，
   *  票由客户端在登录那一刻自己领回来）。 */
  function signedIn() {
    hardFail = false;
    var sync = Promise.resolve(null);
    if (typeof MtRelay !== "undefined" && MtRelay.syncIfStale) {
      try {
        sync = Promise.resolve(MtRelay.syncIfStale()).then(
          function () {},
          function () {},
        );
      } catch (e) {}
    }
    return sync.then(function () {
      return refresh();
    });
  }

  function init() {
    if (!window.api || typeof window.api.onAuthChanged !== "function") return;
    window.api.onAuthChanged(function () {
      refresh();
      /* 中转卡上的「凭据」那一行跟着刷新（有卡时才真动手） */
      if (typeof MtRelay !== "undefined" && MtRelay.syncIfStale) {
        try {
          MtRelay.syncIfStale();
        } catch (e) {}
      }
    });
    /* 登录成功的那一刻也重算一次（auth:changed 与「领到新票」谁先到都兜得住） */
    if (typeof window.MTNodeAuth !== "undefined" && window.MTNodeAuth.onChange) {
      try {
        window.MTNodeAuth.onChange(function () {
          signedIn();
        });
      } catch (e) {}
    }
    try {
      refresh();
    } catch (e) {}
  }

  window.mtRelayAuthNotice = mtRelayAuthNotice;
  window.MtRelayAuth = {
    notice: mtRelayAuthNotice,
    refresh: refresh,
    signedIn: signedIn,
    init: init,
    last: function () {
      return last;
    },
    BAR_ID: BAR_ID,
    /* 卡上「凭据有效期」那一行用（app-settings.js）；也给自检用 */
    ts: fmtTs,
  };
})();
