/* renderer/app-keys.js — 顶栏入口的全局快捷键（自包含，无依赖）
 * ============================================================================
 * 需求：为顶栏 8 个入口配键盘快捷键 ——
 *   1 = 画布（#btnToolWf）      2 = 会话（#btnToolAgent）   3 = 专家团（#btnTeam）
 *   Space = 居中（#btnFit）     D = 隐藏线（#btnHideWires）
 *   J = 插件（#btnPlugins）     K = 工具库（#btnTools）      L = 素材库（#btnAssets）
 * 鼠标 hover 到按钮时，提示里同时显示快捷键（由 i18n.js 的 applyDom 读
 * index.html 上的 data-shortcut 追加「 · 快捷键 X」，本文件不重复维护文案）。
 *
 * 设计要点（为什么这么写）：
 *   · 键位单一真源 = index.html 按钮上的 data-shortcut；本文件只负责「按键 → 点按钮」，
 *     动作全部走按钮自己的 onclick（app-boot.js 已有接线），不另抄一份动作表，
 *     避免同一个入口出现两套会走偏的逻辑。
 *   · 只在非输入 / 非浮层场合触发：任何 input / textarea / select / contenteditable
 *     （以及 role="textbox"）里打字时不抢键；全屏浮层（#overlay、.mt-dialog、
 *     全局搜索、图片灯箱）开着时不穿透。
 *   · Space 额外让位给「当前有焦点的可点控件」：按钮获得焦点时按空格是原生点击，
 *     不能再叠加一次居中。字母 / 数字键没有这个冲突，不设此闸。
 *   · 居中 / 隐藏线是画布操作：只在画布视图（body.view-workflow）里响应，
 *     免得在会话 / 专家团视图里按住空格把背后的画布缩放一通。
 *   · 重入（长按自动重复）与输入法组合态一律忽略。
 * ============================================================================
 */
(function () {
  "use strict";

  /* 键位归一：Space / Spacebar / " " 统一成 " "；字母统一小写 */
  function normKey(raw) {
    var k = String(raw == null ? "" : raw).trim().toLowerCase();
    if (k === "space" || k === "spacebar") return " ";
    return k;
  }

  /* 建「按键 → 按钮」表：只认顶栏里带 data-shortcut 的入口 */
  function buildMap() {
    var map = Object.create(null);
    var els = document.querySelectorAll(".topbar [data-shortcut]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var k = normKey(el.getAttribute("data-shortcut"));
      /* 同一个键位重复挂只取第一个，静默忽略后面的（不 throw，免得一个笔误废掉全部快捷键） */
      if (k && !map[k]) map[k] = el;
    }
    return map;
  }

  /* 是不是「正在输入 / 正在编辑」的元素 */
  function isEditableEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.closest)
      return !!el.closest(
        '[contenteditable="true"],[contenteditable=""],[role="textbox"]',
      );
    return false;
  }

  /* 有没有全屏浮层挡在前面（开着时快捷键不得穿透到被遮住的界面） */
  function blockingLayerOpen() {
    var ov = document.getElementById("overlay");
    if (ov && (ov.style.display === "flex" || ov.classList.contains("on")))
      return true;
    /* .mt-dialog 是全应用统一的模态宿主（素材库 / 审阅 / 益智窗 / 确认框…），.on = 打开 */
    if (document.querySelector(".mt-dialog.on")) return true;
    var gs = document.getElementById("gsLayer");
    if (gs && gs.classList.contains("on")) return true;
    var lb = document.getElementById("imgLb");
    if (lb && lb.classList.contains("on")) return true;
    return false;
  }

  /* Space 的额外闸：焦点落在可点控件上时，空格是它的原生激活键 */
  function focusOnActivatable() {
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement || ae.nodeType !== 1)
      return false;
    if (isEditableEl(ae)) return true;
    var tag = (ae.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a" || tag === "summary") return true;
    if (ae.getAttribute && ae.getAttribute("role") === "button") return true;
    /* 自定义可聚焦控件（tabindex >= 0，如可点表格行 / 拖放区）：空格是它们的激活键 */
    if (typeof ae.tabIndex === "number" && ae.tabIndex >= 0) return true;
    return false;
  }

  var MAP = buildMap();

  function onKeydown(ev) {
    /* 组合键一律不占：本功能的键位都是「单键」 */
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    if (ev.isComposing || ev.repeat) return;
    var key = normKey(ev.key);
    if (!key) return;
    var btn = MAP[key];
    if (!btn) return;
    /* 输入框 / 文本域 / 富文本（含焦点在别处的可编辑区）里不抢键 */
    if (isEditableEl(ev.target) || isEditableEl(document.activeElement)) return;
    if (blockingLayerOpen()) return;
    if (key === " " && focusOnActivatable()) return;
    /* 居中 / 隐藏线属于画布：只在画布视图响应 */
    if ((btn.id === "btnFit" || btn.id === "btnHideWires") &&
        !document.body.classList.contains("view-workflow"))
      return;
    if (btn.disabled) return;
    /* Space 的默认行为是滚动，必须先拦；随后原样触发按钮自己的点击逻辑 */
    ev.preventDefault();
    btn.click();
  }

  window.addEventListener("keydown", onKeydown, false);

  /* 供别的模块按需重建（例如往顶栏动态插了带 data-shortcut 的入口） */
  window.rebindShortcutKeys = function () {
    MAP = buildMap();
  };
})();
