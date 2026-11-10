/* renderer/app-status-keys.js — 状态栏左下角四颗按钮的**窗内**快捷键（自包含，无依赖）。
 * ============================================================================
 * 键位表（唯一真源就是这里，按钮上的 title 文案跟着它写）：
 *   F1 = 快捷会话（#btnMiniChat，开 / 关那只唯一的独立小窗）
 *   F2 = DeepSeek 对话（#btnDeepSeek，开 / 关页面右半边的抽屉）
 *   F3 = 语音播报（#btnTts，开 / 关，等同左键点它）
 *   F4 = 语音输入（#btnVoiceGlobal，关 → 开持续转录；再按 → 关。
 *        处在「按键转录」态时 F4 是**按住说话**，那两个事件仍归 renderer/app-voice.js
 *        自己的 keydown / keyup 处理，这里只放行、不吞键）
 *   AI 增强（#btnVoiceEnhance）**没有**快捷键，且只在语音输入开启时露面。
 *
 * 为什么是「窗内」而不是全局热键：
 *   全局热键会把系统里的 F2（资源管理器重命名）/ F3（搜索）/ F4（地址栏）一起吃掉。
 *   本轮口径（用户确认）：四颗键统一只在 MTNode 窗口内生效 —— 主进程不再注册
 *   globalShortcut（mini-chat-window.js 里那条 F1 已摘掉），按键只在焦点位于本窗口时
 *   才有响应；webview（DeepSeek 网页）里按 F2 也**不会**冒到这里 —— 那一颗由主进程在
 *   guest 的 before-input-event 上截下、经 api.onDeepSeekHotkey 转给 app-deepseek.js，
 *   所以焦点在网页里也照样能再按一次把抽屉收回去。
 *
 * 设计纪律：
 *   · **动作不另抄一份**：全走既有入口 —— window.toggleDeepSeekDrawer / window.MTNodeTts.toggle /
 *     window.VoiceInput.setMode / 主进程 minichat:toggle。没有哪个入口就退一步点那颗按钮，
 *     再没有就什么都不做（不 throw、不静默假装成功）。
 *   · 带 Ctrl / Alt / Meta 的组合键一律放行（DevTools 与系统快捷键要能照用）；
 *     长按自动重复（ev.repeat）与输入法组合态（isComposing）一律忽略。
 *   · 只在**捕获阶段**挂 document 一层：与 app-voice.js 的 F4 处理同层，靠注册顺序
 *     （voice 先注册）保证「按住说话」优先拿到 F4。
 * ============================================================================
 */
(function () {
  "use strict";

  /* ── 四个动作：都先走现成入口，取不到再退回点按钮 ─────────────────────── */

  /** F1：快捷会话小窗开关（主进程 minichat:toggle 是唯一实现；老 preload 退回 open） */
  function toggleMiniChat() {
    var a = window.api || null;
    if (!a) return false;
    try {
      if (typeof a.miniChatToggle === "function") {
        Promise.resolve(a.miniChatToggle()).catch(function () {});
        return true;
      }
      if (typeof a.miniChatOpen === "function") {
        Promise.resolve(a.miniChatOpen()).catch(function () {});
        return true;
      }
    } catch (_) {}
    return false;
  }

  /** F2：DeepSeek 抽屉（app-deepseek.js 已把 toggle 挂成 window.toggleDeepSeekDrawer） */
  function toggleDeepSeek() {
    if (typeof window.toggleDeepSeekDrawer === "function") {
      try {
        window.toggleDeepSeekDrawer();
        return true;
      } catch (_) {}
    }
    var b = document.getElementById("btnDeepSeek");
    if (b) {
      b.click();
      return true;
    }
    return false;
  }

  /** F3：语音播报开 / 关（与左键点 #btnTts 同一条路径：内部已有下载确认与互斥） */
  function toggleTts() {
    var T = window.MTNodeTts;
    if (T && typeof T.toggle === "function") {
      try {
        T.toggle();
        return true;
      } catch (_) {}
    }
    var b = document.getElementById("btnTts");
    if (b) {
      b.click();
      return true;
    }
    return false;
  }

  /** F4：语音输入开 / 关。返回 false = 这次不拦（按键转录态交给 app-voice.js 起录） */
  function toggleVoice() {
    var V = window.VoiceInput;
    if (!V || typeof V.mode !== "function" || typeof V.setMode !== "function") return false;
    var m = String(V.mode() || "off");
    if (m === "ptt") return false; /* 按键转录态：按住 F4 说话，起录 / 松开归语音模块 */
    V.setMode(m === "off" ? "live" : "off");
    return true;
  }

  /* ── 键名归一：老引擎只给 keyCode / code，key 才是主路 ─────────────────── */
  function keyName(ev) {
    var k = String((ev && ev.key) || "");
    if (/^F[1-4]$/.test(k)) return k;
    var c = String((ev && ev.code) || "");
    if (/^F[1-4]$/.test(c)) return c;
    return "";
  }

  function onKeyDown(ev) {
    if (!ev || ev.repeat || ev.isComposing) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return; /* 组合键放行 */
    var k = keyName(ev);
    if (!k) return;
    var handled = false;
    try {
      if (k === "F1") handled = toggleMiniChat();
      else if (k === "F2") handled = toggleDeepSeek();
      else if (k === "F3") handled = toggleTts();
      else if (k === "F4") handled = toggleVoice();
    } catch (_) {
      handled = false;
    }
    if (!handled) return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  function install() {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", onKeyDown, true);
  }

  /* 排障 / 冒烟入口（正常运行时没人调） */
  window.MTStatusKeys = {
    keys: { F1: "minichat", F2: "deepseek", F3: "tts", F4: "voice" },
    press: (k) => {
      onKeyDown({
        key: String(k || ""),
        code: String(k || ""),
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault() {},
        stopPropagation() {},
      });
    },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
