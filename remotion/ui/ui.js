(() => {
  const api = window.remotionApi;
  if (!api) {
    document.body.textContent = "remotionApi missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const installDirEl = $("installDir");
  const installStep = $("installStep");
  const installBar = $("installBar").querySelector("i");
  const consoleEl = $("console");
  const svcBadge = $("svcBadge");

  function setBar(el, pct) {
    el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function refresh() {
    const st = await api.getStatus();
    installDirEl.textContent = st.installDir || "未设置";

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

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    $("btnCancelInstall").disabled = !st.installing;
    $("btnClearMeta").disabled = !!st.installing || !!st.rendering;
    return st;
  }

  $("btnDir").onclick = async () => {
    const r = await api.pickInstallDir();
    if (r && r.ok) {
      logLine("installDir=" + r.installDir);
      if (r.runtimeReady) logLine("发现已有 remotion 运行时，可直接渲染。");
    } else if (r && r.error) {
      logLine("目录无效: " + r.error);
      alert("目录无效：" + r.error + "\n请勿选择磁盘根目录或系统目录。");
    }
    refresh();
  };

  $("btnInstall").onclick = async () => {
    const disk = await api.freeDisk();
    if (disk && disk.freeGb != null && disk.freeGb < (disk.needGb || 8)) {
      const ok = confirm(
        `磁盘剩余约 ${disk.freeGb}GB，建议预留 ≥${disk.needGb}GB。\n仍要继续安装吗？`,
      );
      if (!ok) return;
    }
    logLine("开始安装（复制 remotion-pack → npm install）…");
    const r = await api.install({ force: true });
    if (r && r.ok) {
      logLine("安装完成 v" + (r.version || "") + " → " + r.installDir);
    } else {
      logLine("安装失败: " + ((r && (r.message || r.error)) || "未知错误"));
    }
    refresh();
  };

  $("btnCancelInstall").onclick = async () => {
    logLine("取消安装…");
    await api.cancelInstall();
  };

  $("btnClearMeta").onclick = async () => {
    const ok = confirm("仅移除数据目录入口（控制台 UI 等）？安装目录与配置将保留。");
    if (!ok) return;
    const r = await api.removePluginMeta();
    logLine(r && r.ok ? "已移除入口；安装目录保留: " + (r.keptInstallDir || "—") : "移除失败");
    refresh();
  };

  $("btnClearLog").onclick = () => {
    consoleEl.textContent = "";
  };

  api.onProgress((ev) => {
    if (!ev) return;
    installStep.textContent =
      (ev.stepLabel || ev.step || (ev.phase === "render" ? "渲染" : "")) +
      (ev.message ? " — " + ev.message : "");
    setBar(installBar, ev.pct || 0);
  });
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
