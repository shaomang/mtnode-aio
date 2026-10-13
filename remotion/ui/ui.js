(() => {
  const api = window.remotionApi;
  if (!api) {
    document.body.textContent = "remotionApi missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const consoleEl = $("console");
  const svcBadge = $("svcBadge");

  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function refresh() {
    const st = await api.getStatus();
    $("stInstallDir").textContent = st.installDir || "未设置";

    const ready = !!st.runtimeReady;
    svcBadge.textContent = st.rendering ? "渲染中…" : ready ? "就绪" : st.installed ? "已安装（未就绪）" : "未安装";
    svcBadge.className = "badge " + (st.rendering ? "work" : ready ? "on" : "off");

    $("stRuntime").textContent = ready ? "✓ node_modules/remotion" : st.installDir ? "未检测到" : "—";
    $("stVersion").textContent = st.version || "—";
    $("stRendering").textContent = st.rendering ? "是" : "否";
    const lock = st.lock;
    $("stLock").textContent = lock ? (lock.nodeId || "占用中") : "空闲";
    $("renderState").textContent = st.renderState
      ? `渲染中 node=${st.renderState.nodeId || "?"} · ${st.renderState.pct || 0}%` +
        (st.renderState.outputPath ? " → " + st.renderState.outputPath : "")
      : "";

    $("btnClearMeta").disabled = !!st.installing || !!st.rendering;
    return st;
  }

  /* 环境自检（只读）：安装失败时用户手上往往什么都没有 —— 这一颗当场把
     node / npm、目录可写、磁盘、npm 源、随包脚手架与安装脚本逐项列出来。 */
  $("btnSelfCheck").onclick = async () => {
    const btn = $("btnSelfCheck");
    btn.disabled = true;
    logLine("[selfcheck] 正在自检环境…");
    try {
      const r = typeof api.selfcheck === "function" ? await api.selfcheck() : { ok: false, error: "版本过旧：控制台没有自检桥" };
      if (!r || !r.ok) {
        logLine("[selfcheck] 自检失败：" + String((r && r.error) || "unknown"));
        return;
      }
      for (const line of r.lines || []) logLine(line);
      /* ok = 自检这趟跑成功了；pass = 环境这一趟过了（必需项全过）—— 报警只看 pass */
      const bad = (r.items || []).filter((x) => x.required && !x.ok);
      const notice = $("selfCheckNotice");
      if (notice) {
        notice.hidden = !bad.length;
        notice.textContent = bad.length
          ? "环境自检未通过：" +
            bad.map((x) => x.label).join(" / ") +
            "。逐项修法见下面 console 里的 [selfcheck] 行；修好后回到「插件」对话框点「安装 / 重装」。"
          : "";
      }
      if (!bad.length) logLine("[selfcheck] 必需项全部通过（" + (r.pass ? "环境就绪" : "有非必需项待留意") + "）。");
    } catch (e) {
      logLine("[selfcheck] 自检异常：" + String((e && e.message) || e));
    } finally {
      btn.disabled = false;
    }
  };

  $("btnClearMeta").onclick = async () => {
    const ok = confirm("仅移除数据目录入口（控制台 UI 等）？安装目录与配置将保留。");
    if (!ok) return;
    const r = await api.removePluginMeta();
    logLine(r && r.ok ? "已移除入口；安装目录保留: " + (r.keptInstallDir || "—") : "移除失败");
    refresh();
  };

  /* 清空 = 真清日志文件（truncate 到 0 字节），不是只清这块视图：
     关窗再开旧日志不该回来。写完文件后宿主广播 consoleCleared，打开的窗就地清空。 */
  const clearConsoleView = () => {
    consoleEl.textContent = "";
  };
  $("btnClearLog").onclick = async () => {
    let failed = "";
    if (typeof api.consoleClear === "function") {
      try {
        const r = await api.consoleClear();
        if (!r || !r.ok) failed = String((r && r.error) || "clear_failed");
      } catch (e) {
        failed = String((e && e.message) || e);
      }
    }
    /* 即使清文件失败，界面至少也要清掉（用户点的是「清空」） */
    clearConsoleView();
    if (failed) logLine("[console] 清空日志文件失败：" + failed);
  };
  if (typeof api.onConsoleCleared === "function") api.onConsoleCleared(() => clearConsoleView());

  /* 不再订阅 onProgress：安装进度归独立安装窗；渲染进度主进程已逐行写进 console，
     这里再由 onConsole 收一遍，重复订阅只会让同一行出现两次。 */

  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });

  (async () => {
    const tail = await api.consoleTail(48 * 1024);
    if (tail && tail.text) consoleEl.textContent = tail.text;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    await refresh();
    setInterval(refresh, 4000);
  })();
})();
