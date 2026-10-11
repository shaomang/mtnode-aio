(() => {
  const api = window.music3Api;
  if (!api) {
    document.body.textContent = "music3Api missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const consoleEl = $("console");
  const svcBadge = $("svcBadge");
  const gpuMemBar = $("gpuMemBar").querySelector("i");
  const gpuUtilBar = $("gpuUtilBar").querySelector("i");
  const gpuMemTxt = $("gpuMemTxt");
  const gpuUtilTxt = $("gpuUtilTxt");
  const modal = $("modal");

  function setBar(el, pct) {
    el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function refresh() {
    const st = await api.getStatus();
    const running = !!st.running || !!st.gradioUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");

    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;
    $("btnUninstall").disabled = !st.installDir || !!st.installing;

    if (st.gpu) applyGpu(st.gpu);
    return st;
  }

  function applyGpu(gpu) {
    if (!gpu) return;
    gpuMemTxt.textContent = `${gpu.memUsed}/${gpu.memTotal} MiB (${gpu.memPct || 0}%) · ${gpu.name || ""}`;
    gpuUtilTxt.textContent = `${gpu.util || 0}%`;
    setBar(gpuMemBar, gpu.memPct);
    setBar(gpuUtilBar, gpu.util);
  }

  /* 安装目录选择 / 「安装」/ 「自我修复」/ 安装进度都不在这只窗里了：
     安装相关操作与显示统一收进独立安装窗（plugins/main-install.js）；
     宿主侧的 music3:pickInstallDir / music3:install / music3:selfRepair 等 IPC 原样保留。 */

  $("btnStart").onclick = async () => {
    logLine("手动启动后端（调试）…");
    const r = await api.start();
    logLine(r && r.ok ? "服务已启动" + (r.port ? " :" + r.port : "") : "启动失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnStop").onclick = async () => {
    const r = await api.stop();
    logLine(r && r.ok ? "服务已停止" : "关闭失败");
    refresh();
  };

  $("btnForceKill").onclick = async () => {
    if (!api.forceKillBackend) return;
    const ok = confirm(
      "强制结束后端并释放显存？\n适用于 GPU 跑满却永远不结束的情况。\n之后需重新点「启用服务」。",
    );
    if (!ok) return;
    logLine("强制释放显存…");
    const r = await api.forceKillBackend();
    logLine(r && r.ok ? "已结束后端，显存应已释放；请重新启用服务" : "失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnUninstall").onclick = async () => {
    const prev = await api.uninstallPreview();
    if (!prev || !prev.ok) {
      alert("无法卸载：" + ((prev && prev.error) || "未知错误"));
      return;
    }
    const ul = $("uninstallList");
    ul.innerHTML = "";
    for (const t of prev.targets || []) {
      const li = document.createElement("li");
      li.textContent = `${t.note || t.rel}: ${t.path}`;
      ul.appendChild(li);
    }
    $("delOutput").checked = false;
    modal.classList.add("show");
  };

  $("btnCancelUn").onclick = () => modal.classList.remove("show");
  $("btnConfirmUn").onclick = async () => {
    modal.classList.remove("show");
    const r = await api.uninstall({
      confirm: true,
      deleteOutput: !!$("delOutput").checked,
    });
    logLine(r && r.ok ? "卸载完成（安装目录配置已保留，便于再次发现）" : "卸载失败: " + ((r && r.error) || ""));
    refresh();
  };

  /* ───── 清空日志：真删文件内容（不只是清显示）─────
   * 旧实现只把 DOM 清空，关窗再开宿主一 consoleTail 旧日志又回来了。
   * 现在先让宿主 truncate 日志文件（宿主保留文件句柄，后端往同一个 inode 续写），
   * 再清 DOM 并复位增量游标 lastLogLen；宿主广播 music3:consoleCleared 时做同样的事
   * （别的窗口点的清空，这只窗也要跟着空）。 */
  let lastLogLen = 0;
  function clearLogView() {
    consoleEl.textContent = "";
    lastLogLen = 0;
  }
  async function clearLog() {
    let r = null;
    try {
      if (api.consoleClear) r = await api.consoleClear();
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    clearLogView();
    if (r && r.ok === false) logLine("[log] 清空日志文件失败：" + (r.error || "未知错误") + "（界面已清空）");
  }
  $("btnClearLog").onclick = clearLog;
  if (api.onConsoleCleared) api.onConsoleCleared(() => clearLogView());

  /* 进度事件订阅：安装 / Agent 兜底那两档的界面已不在本窗（统一走独立安装窗），
     回调里不再碰任何安装元素；只剩生成档写一行日志，免得生成期间界面一片死寂。 */
  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "generate") logLine("生成: " + (ev.message || ""));
  });
  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });
  api.onGpu(applyGpu);

  (async () => {
    const tail = await api.consoleTail(48 * 1024);
    if (tail && tail.text) consoleEl.textContent = tail.text;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    lastLogLen = (tail && tail.text && tail.text.length) || 0;
    await refresh();
    setInterval(refresh, 4000);
    /* Gradio stdout is appended to the log file; poll so the UI stays live. */
    setInterval(async () => {
      try {
        const t = await api.consoleTail(96 * 1024);
        if (!t || !t.text) return;
        if (t.text.length === lastLogLen) return;
        lastLogLen = t.text.length;
        const atBottom =
          consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
        consoleEl.textContent = t.text;
        if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
      } catch {}
    }, 1500);
  })();
})();
