(() => {
  const api = window.h3Api;
  if (!api) {
    document.body.textContent = "h3Api missing";
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

    const running = !!st.running || !!st.comfyUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");

    $("btnInstall").disabled = !st.installDir || !!st.installing;
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
      logLine("Agent 安装失败: " + err);
      if (!r || r.agentRecoverable === false || err === "cancelled" || err === "busy") return r;
      if (!api.agentRecoverInstall) return r;
      const ok = confirm(
        `Agent 安装失败：${err}\n\n是否再让 Agent 诊断并重试？\n（脚手架仅作参考；不会启动后端服务）`,
      );
      if (!ok) {
        logLine("已取消 Agent 再试");
        return r;
      }
      logLine("已确认：Agent 再试…");
      const r2 = await api.agentRecoverInstall({ error: err });
      if (r2 && r2.ok) logLine("Agent 保底安装完成");
      else logLine("Agent 再试仍失败: " + ((r2 && (r2.message || r2.error)) || ""));
      return r2;
    }

    const disk = await api.freeDisk();
    if (disk && disk.freeGb != null && disk.freeGb < (disk.needGb || 70)) {
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

  $("btnStart").onclick = async () => {
    logLine("正在启用服务…");
    const r = await api.start();
    logLine(r && r.ok ? "服务已启用" + (r.port ? " :" + r.port : "") : "启动失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnStop").onclick = async () => {
    const r = await api.stop();
    logLine(r && r.ok ? "服务已关闭" : "关闭失败");
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
  })();
})();

