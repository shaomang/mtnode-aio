/* CDP 面板（renderer/app-devtools.js + css/dsh-tokens.css 的 .dsh-cdp-*）
 *
 * 需求「网关内置 web server + MTNode 内置浏览器视图开 DevTools 前端（Console / Network /
 * Cordis 树）」的落地口径：**不自己重写 Console / Network** —— 直接把这台浏览器自带的
 * DevTools 前端（Chromium 调试端点 serve 的 /devtools/ 页面，同源、直连本机 CDP）内嵌
 * 进来。于是 Console / Network / Sources / Performance 全套与用户熟悉的浏览器一模一样，
 * 我们零依赖、零重复实现；「Cordis 树」那一项由 dsh 运行时自己的配置面覆盖，不在这里造。
 *
 * 数据通道：走既有浏览器桥 —— `{action:'devtools'}` → 网关 BrowserHost.devtoolsUrl()
 * → 返回 { ok, url }。没有新接口、不落库、不进模型上下文。
 *
 * 显隐：设置 · 开发者工具（S.config.dsh.developerTools，默认开）关掉时，入口按钮不出现。
 * 面板本身是右栏里的一个内嵌视图，与「浏览器活动」列表互斥（同一格换内容）。
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  function devOn() {
    try {
      const d = (window.S && S.config && S.config.dsh) || {};
      return d.developerTools !== false;
    } catch {
      return true;
    }
  }
  function sessionId() {
    try {
      return window.S && S.agentSessions && S.agentActive != null && S.agentSessions[S.agentActive]
        ? String(S.agentSessions[S.agentActive].id || "")
        : "";
    } catch {
      return "";
    }
  }

  /* 走既有浏览器桥：app-browser.js 暴露的 BA.browser(action, params)。
     拿不到 BA（老宿主 / 面板没建）就什么都不做，绝不自己造第二条通道。 */
  function browserCall(action, params) {
    const BA = window.BA || (window.MTNodeBrowser && window.MTNodeBrowser.BA);
    if (BA && typeof BA.browser === "function") return BA.browser(action, params || {});
    return Promise.resolve({ ok: false, error: "浏览器面板还没就绪" });
  }

  let box = null;
  let frame = null;
  let noteEl = null;

  function ensurePanel() {
    if (box && box.isConnected) return box;
    const col = $(".ba-col") || $("#agentPane");
    if (!col) return null;
    box = document.createElement("div");
    box.className = "dsh-cdp";
    box.id = "cdpPanel";
    box.hidden = true;

    const head = document.createElement("div");
    head.className = "dsh-cdp-head";
    const title = document.createElement("b");
    title.textContent = "DevTools（CDP）";
    head.appendChild(title);
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "mini btn-sq";
    reload.title = "重新取一次 DevTools 地址";
    reload.textContent = "↻";
    reload.onclick = () => open(true);
    head.appendChild(reload);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mini btn-sq";
    close.title = "收起 DevTools";
    close.textContent = "✕";
    close.onclick = () => hide();
    head.appendChild(close);
    box.appendChild(head);

    noteEl = document.createElement("div");
    noteEl.className = "dsh-cdp-note";
    box.appendChild(noteEl);

    frame = document.createElement("iframe");
    frame.className = "dsh-cdp-frame";
    frame.setAttribute("title", "DevTools");
    /* 只给这一件事的权限：DevTools 前端要连本机 CDP WebSocket */
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    box.appendChild(frame);

    col.appendChild(box);
    return box;
  }

  /** 打开（force=true 时重新取地址，用于「页面换了」之后） */
  async function open(force) {
    if (!devOn()) return { ok: false, reason: "开发者工具已关闭（设置 · 智能能力）" };
    /* CDP 面板与浏览器活动列表共用右栏那一格：把列表让出来 */
    const baList = $("#baList");
    const baFoot = $(".ba-foot");
    const baBar = $(".ba-bar");
    const p = ensurePanel();
    if (!p) return { ok: false, reason: "右栏还没建" };
    if (baList) baList.style.display = "none";
    if (baBar) baBar.style.display = "none";
    if (baFoot) baFoot.style.display = "none";
    p.hidden = false;
    if (!force && frame.src) return { ok: true, cached: true };
    noteEl.textContent = "正在取 DevTools 前端地址…";
    const r = await browserCall("devtools", sessionId() ? { sessionId: sessionId() } : {});
    const url = r && r.url ? String(r.url) : "";
    if (!url) {
      noteEl.textContent =
        "拿不到 DevTools 地址：" + ((r && (r.reason || r.error)) || "浏览器可能还没启动（先在面板点「打开浏览器」）。");
      frame.removeAttribute("src");
      return { ok: false, reason: noteEl.textContent };
    }
    noteEl.textContent = "这是这台浏览器**自带**的 DevTools 前端（同源直连本机 CDP）；Console / Network / Sources 全套。";
    frame.src = url;
    return { ok: true, url };
  }

  function hide() {
    if (box) box.hidden = true;
    const baList = $("#baList");
    const baFoot = $(".ba-foot");
    const baBar = $(".ba-bar");
    if (baList) baList.style.display = "";
    if (baBar) baBar.style.display = "";
    if (baFoot) baFoot.style.display = "";
  }

  function toggle() {
    if (box && !box.hidden) return hide();
    return open(false);
  }

  window.MTNodeDevtools = { open, hide, toggle, devOn };

  /* 入口按钮：挂在浏览器活动栏的工具条里（与「打开浏览器 / 停止 / 接管 / 名单」同排）。
     开发者工具关着 = 这枚按钮根本不出现。 */
  function installButton() {
    if (!devOn()) return;
    const bar = $(".ba-bar");
    if (!bar || $("#baCdp")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini";
    btn.id = "baCdp";
    btn.textContent = "DevTools";
    btn.title = "开这台浏览器自带的 DevTools 前端（Console / Network / Sources；设置 · 开发者工具）";
    btn.onclick = () => toggle();
    bar.appendChild(btn);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installButton);
  } else {
    installButton();
  }
  /* 面板可能晚于本脚本建（浏览器活动面板按需建）：低频补挂一次入口 */
  setInterval(installButton, 2000);
})();
