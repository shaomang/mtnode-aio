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
