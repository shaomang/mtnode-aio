/* renderer/app-hotkeys.js — 应用窗口里的宿主快捷键（F1–F4 / Ctrl+Tab，自包含，无依赖）。
 * ============================================================================
 * 现场（用户报的 bug）：在应用中心打开的应用窗口（mt-tex 等）里按 F1–F4 与 Ctrl+Tab
 * **一点反应都没有**。原因很直：判这两组键的两份脚本都只加载在主窗 index.html 里 ——
 *   · F1–F4    → renderer/app-status-keys.js
 *   · Ctrl+Tab → renderer/app-fim.js（补全总开关）
 * 而应用窗口是**另一只 BrowserWindow**，页面还是用户自己的 index.html，这两份都不在里面。
 *
 * 本脚本由 preload-app.js **无条件注入**每个应用窗口，只做两件事：判键、转发
 * （window.__mtnodeHostKey → 主进程 hostkey:run）。动作一概不在这里重写：
 *   · Ctrl+Tab → 输入补全总开关（主进程改 config.json 的 fim.on 并广播，主窗那颗
 *     #btnFim 与别的应用窗口一起跟上）。**声明了 showComplete 的应用**里补全内核
 *     （renderer/app-fim.js）自己吃这颗键，本脚本见 window.MTFimOverlay 就放手。
 *   · F1 → 快捷会话小窗开 / 关（mini-chat-window.js 的 toggle，主进程是唯一实现）。
 *   · F2 / F3 / F4 → 主窗那一套（DeepSeek 抽屉 / 语音播报 / 语音输入），主进程先把主窗
 *     亮出来，再经 "status:hotkey" 交给 renderer/app-status-keys.js 的同一个 press。
 *
 * 不抢应用自己的键（既有口径优先）：
 *   · 应用声明了听写（showDictate → renderer/app-speech-ui.js 注入）时，
 *     F2 = 持续转录开关键、F3 = 按住说话，这两颗**原样留给听写**；
 *   · F4 在有听写的窗口里 = 听写三态切换（关 ↔ 持续转录），按键转录态放行给「按住说话」。
 * 带 Ctrl / Alt / ⌘ 的组合键（Ctrl+Tab 除外）一律放行：DevTools 与应用自己的快捷键照用；
 * 长按自动重复（ev.repeat）与输入法组合态（isComposing）一律忽略。
 * ============================================================================
 */
(function () {
  "use strict";

  /* 转给主进程（preload-app.js 的 __mtnodeHostKey）。没有这条桥 = 老宿主，静默不做事。 */
  function hostKey(key) {
    var f = window.__mtnodeHostKey;
    if (typeof f !== "function") return false;
    try {
      Promise.resolve(f(key)).catch(function () {});
      return true;
    } catch (_) {
      return false;
    }
  }

  function eat(ev) {
    try {
      if (ev.preventDefault) ev.preventDefault();
    } catch (_) {}
    try {
      if (ev.stopPropagation) ev.stopPropagation();
    } catch (_) {}
  }

  /* 老引擎只给 keyCode / code，key 才是主路 */
  function fnKey(ev) {
    var k = String((ev && ev.key) || "");
    if (/^F[1-4]$/.test(k)) return k;
    var c = String((ev && ev.code) || "");
    if (/^F[1-4]$/.test(c)) return c;
    return "";
  }

  /* 这颗功能键是不是已经归本窗的听写条了（app.json 的 showDictate）*/
  function dictateOwns(k) {
    try {
      if (typeof window.apSpeechToggle !== "function") return false;
      if (k === "F2") return String(window.apSpeechHotkey || "") === "F2";
      if (k === "F3") return String(window.apSpeechPttKey || "") === "F3";
    } catch (_) {}
    return false;
  }

  function onKeyDown(ev) {
    if (!ev || ev.repeat || ev.isComposing) return;
    var key = String(ev.key || "");

    /* Ctrl + Tab = 输入补全总开关（与主窗同一个语义）。补全内核在的窗口里它自己吃这颗键，
       这里直接放手，免得翻两次（一开一关）。 */
    if (
      (key === "Tab" || ev.keyCode === 9) &&
      ev.ctrlKey &&
      !ev.shiftKey &&
      !ev.altKey &&
      !ev.metaKey
    ) {
      if (window.MTFimOverlay) return;
      if (hostKey("fim")) eat(ev);
      return;
    }

    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    var k = fnKey(ev);
    if (!k) return;
    if (dictateOwns(k)) return; /* 听写条自己那一颗：放行 */

    /* F4：有听写条的窗口里归听写（关 → 持续转录）；按键转录态是「按住说话」，放行 */
    if (k === "F4" && typeof window.apSpeechSetMode === "function") {
      try {
        var m = String(
          (typeof window.apSpeechMode === "function" ? window.apSpeechMode() : "") || "off",
        );
        if (m === "ptt") return;
        eat(ev);
        window.apSpeechSetMode(m === "off" ? "live" : "off");
      } catch (_) {}
      return;
    }

    if (hostKey(k)) eat(ev);
  }

  window.addEventListener("keydown", onKeyDown, true);

  /* 排障 / 冒烟入口（正常运行时没人调） */
  window.MTAppHotkeys = {
    keys: { F1: "minichat", F2: "deepseek", F3: "tts", F4: "voice", "Ctrl+Tab": "fim" },
    press: function (k) {
      onKeyDown({
        key: String(k || ""),
        code: String(k || ""),
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: function () {},
        stopPropagation: function () {},
      });
    },
  };
})();
