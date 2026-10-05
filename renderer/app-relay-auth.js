/* MTNode 中转服务 · 凭据提示 —— 自包含小模块，全局 window.MtRelayAuth（+ mtRelayAuthNotice）
 *
 * 它解决什么：中转站（store-saas/relay.mjs）在「没带凭据 / 凭据已失效」时回 401，文案是
 * 「缺少或已失效的中转 Key」—— 用户看到的第一反应是「去提供商里填 Key」，而中转卡上并没有
 * 可手填的输入框（Key 由账号托管、显示在卡上供复制给外部客户端），于是反复撞同一个错。
 * 所以凭据失效必须由客户端主动说清并给出动作。
 *
 * 本轮口径（用户明确要求）：
 *   · **永久移除**「本机的登录凭据读不出来（已留档并清理）：请重新登录一次」这类把责任推给
 *     用户的提示 —— 顶部常驻横幅（.relay-auth-bar）、可点 toast 与相关 i18n 词条全部删除；
 *     本机凭据万一又「写得出去读不回来」，auth-store.js 会自己改用本机密钥加密重存（全程零提示）。
 *   · **不再让用户重新登录**：「Key 分发一次后不应当失效」——服务端 /api/relay/me 已改成幂发
 *     同一张 3650 天票（多开客户端 / 多台机器 / 重登都不再互相顶掉），撞 401 由主进程
 *     （main.js 的 ensureRelayCredential）静默换票并重发这一次请求，用户零操作。
 *   · 真的救不回来时，界面只说一句人话：**无效的 API Key**（与 OpenAI 的 invalid_api_key 同口径），
 *     不再把上游那一大段 JSON 甩到界面上。
 *
 * 事实来源：主进程的 relay:keyInfo（relayKeyInfo()）—— 回 signedIn / key / fromConfig /
 * expiresAt / renewDue / rotate 等状态（Key 明文现在也在卡上显示，见 renderer/app-relay.js）。
 * 本模块不读任何存储。
 *
 * 口径：
 *   · 只认中转链路（别的服务商 401 = Key 填错，与登录态无关，一律不动）；
 *   · 唯一动作是「登录走完顺手领一次票」（signedIn）：票由客户端自己领，用户不必点任何东西；
 *   · 文案走 I18n（中英词条在 renderer/i18n.js），不硬编码界面语言。
 */
(function () {
  "use strict";

  /* 转不回来的 401 统一说这一句（用户口径）。与 OpenAI 的 invalid_api_key 一致，
     中英词条在 i18n.js；用户看到的永远是这一句，而不是上游那一大段 JSON。 */
  var INVALID_KEY_TEXT = "无效的 API Key";

  var last = null; /* 最近一次 relay:keyInfo 结果（供自检 / 别处读） */
  var firedAt = 0;

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

  /* 唯一还会出现的提示：中转凭据真的用不了（自动补票 + 重试已经失败过）。
     纯 toast（3 秒内同一波 401 只提示一次），没有横幅、没有 ✕、不劝用户重登。 */
  function noticeOnce(text) {
    var now = Date.now();
    if (now - firedAt < 3000) return;
    firedAt = now;
    if (typeof toast === "function") {
      try {
        toast(text, "warn");
        return;
      } catch (e) {}
    }
    var box = document.getElementById("toastBox");
    if (!box) return;
    var d = document.createElement("div");
    d.className = "toast";
    d.textContent = text;
    box.appendChild(d);
    setTimeout(function () {
      d.remove();
    }, 6000);
  }

  /** 中转凭据出问题了（主进程识别到中转 401，且**自动补领也没成功**）。
   *  按「用户现在能做什么」分两句说，但都不提「重新登录」：
   *   · 登录态还在（signedIn），只是票没领到 / 存不住：一句「无效的 API Key」；
   *   · 登录态也没了：这时的动作是**登录**（不是重登），文案里说清「去登录」。
   *  能自动补回来的 401 根本走不到这里（主进程 ensureRelayCredential 已补票并重试）。 */
  function mtRelayAuthNotice() {
    var i = last || {};
    var signedIn = i.signedIn === true;
    if (signedIn) {
      noticeOnce(T(INVALID_KEY_TEXT));
      return;
    }
    noticeOnce(T("MTNode 中转服务需要登录账号：请先登录，再在「设置 · 提供商」里刷新"));
  }

  /** 按主进程的凭据状态刷新本地缓存（启动 / 登录态变化都调它）。
   *  界面上**不再有任何常驻横幅**：这里只是把最新状态留给自己与自检读（last()）。 */
  function refresh() {
    if (!window.api || typeof window.api.relayKeyInfo !== "function") return Promise.resolve(null);
    return Promise.resolve(window.api.relayKeyInfo()).then(
      function (info) {
        last = info || null;
        return info;
      },
      function () {
        return null;
      },
    );
  }

  /** 登录走完（拿到独立票）后：**必须顺手去领一次票**（MtRelay.syncIfStale → 缺独立票时强制同步一次）。
   *  只 refresh() 等于让用户干等 —— 票由客户端在登录那一刻自己领回来，这段过渡期里
   *  一切中转请求都会撞 401（横幅此前就是为此亮的，现已照需求去掉横幅）。 */
  function signedIn() {
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
    /* 「凭据读不出来」的顶部横幅已按需求整块删除（连同 .relay-auth-bar 的样式与词条）：
       本机凭据存不住时 auth-store.js 自己改用本机密钥重存，不给用户派活。 */
    invalidKeyText: INVALID_KEY_TEXT,
    openLogin: openLogin,
    /* 卡上「凭据有效期」那一行现已删除（卡上不再显示凭据说明）；这个时间格式化仍留给
       自检与将来可能的展示用，内部不再有调用点。 */
    ts: fmtTs,
  };
})();
