(() => {
  const api = window.music3Api;
  if (!api) {
    document.body.textContent = "music3Api missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const installDirEl = $("installDir");
  const diskHint = $("diskHint");
  const installStep = $("installStep");
  const subStep = $("subStep");
  const installBar = $("installBar").querySelector("i");
  const subBar = $("subBar").querySelector("i");
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
    installDirEl.textContent = st.installDir || "未设置";
    const proj = st.project || {};
    const bits = [];
    if (proj.scaffold) bits.push("脚手架✓");
    if (proj.venv) bits.push("venv✓");
    if (proj.models) bits.push("模型✓");
    diskHint.textContent =
      `建议预留 ≥${st.diskHintGb || 65}GB。` +
      (bits.length ? " 当前：" + bits.join(" · ") : " 尚未检测到完整安装。");

    const running = !!st.running || !!st.gradioUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    if ($("btnSelfRepair")) $("btnSelfRepair").disabled = !st.installDir || !!st.installing;
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

  $("btnDir").onclick = async () => {
    const r = await api.pickInstallDir();
    if (r && r.ok) {
      logLine("installDir=" + r.installDir);
      if (r.project && r.project.ready) logLine("发现已有完整项目，可直接启用服务。");
    } else if (r && r.error) {
      logLine("目录无效: " + r.error);
      alert("目录无效：" + r.error + "\n请勿选择磁盘根目录或系统目录。");
    }
    refresh();
  };

  $("btnInstall").onclick = async () => {
    async function runInstall(opts) {
      logLine("开始 Agent 安装（脚手架仅作参考）…");
      const r = await api.install(opts || {});
      if (r && r.ok) {
        logLine(r.recoveredByAgent ? "Agent 保底安装完成" : "Agent 安装完成");
        return r;
      }
      const err = (r && (r.message || r.error)) || "未知错误";
      if (r && r.userDeclinedAgent) logLine("已取消 Agent 安装");
      else logLine("Agent 安装失败: " + err);
      return r;
    }

    const disk = await api.freeDisk();
    if (disk && disk.freeGb != null && disk.freeGb < (disk.needGb || 65)) {
      const ok = confirm(
        `磁盘剩余约 ${disk.freeGb}GB，建议预留 ≥${disk.needGb}GB。\n仍要继续安装吗？`,
      );
      if (!ok) return;
      await runInstall({ force: true });
    } else {
      await runInstall({});
    }
    refresh();
  };

  $("btnSelfRepair").onclick = async () => {
    if (!api.selfRepair) {
      logLine("当前版本不支持自我修复");
      return;
    }
    const ok = confirm(
      "自我修复将读取最近的 console 日志，由 Agent 对症修复安装环境（不会启动服务）。\n继续？",
    );
    if (!ok) return;
    logLine("自我修复：读取 console 并交 Agent…");
    const r = await api.selfRepair({});
    if (r && r.ok) logLine("自我修复完成");
    else
      logLine(
        "自我修复失败: " +
          ((r && (r.message || r.error)) || "未知错误") +
          (r && r.consoleBytes != null ? " · log≈" + r.consoleBytes + "B" : ""),
      );
    refresh();
  };

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

  $("btnClearLog").onclick = () => {
    consoleEl.textContent = "";
  };

  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "install" || ev.phase === "dsh") {
      installStep.textContent =
        (ev.stepLabel || ev.step || "") + (ev.message ? " — " + ev.message : "");
      setBar(installBar, ev.pct);
      if (ev.subPct != null) {
        subStep.textContent = "子进度 " + Math.round(ev.subPct) + "%";
        setBar(subBar, ev.subPct);
      }
      if (ev.step === "agent_recover") {
        subStep.textContent = "Agent 保底修复中…";
      }
    }
    if (ev.phase === "generate") {
      installStep.textContent = "生成: " + (ev.message || "");
      setBar(installBar, ev.pct || 0);
    }
  });
  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });
  api.onGpu(applyGpu);

  (async () => {
    const tail = await api.consoleTail(48 * 1024);
    if (tail && tail.text) consoleEl.textContent = tail.text;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    await refresh();
    setInterval(refresh, 4000);
    /* Gradio stdout is appended to the log file; poll so the UI stays live. */
    let lastLen = (tail && tail.text && tail.text.length) || 0;
    setInterval(async () => {
      try {
        const t = await api.consoleTail(96 * 1024);
        if (!t || !t.text) return;
        if (t.text.length === lastLen) return;
        lastLen = t.text.length;
        const atBottom =
          consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
        consoleEl.textContent = t.text;
        if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
      } catch {}
    }, 1500);
  })();
})();
