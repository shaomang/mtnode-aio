(() => {
  const api = window.yueApi;
  if (!api) {
    document.body.textContent = "yueApi missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const installDirEl = $("installDir");
  const diskHint = $("diskHint");
  const diskLine = $("diskLine");
  const installStep = $("installStep");
  const subStep = $("subStep");
  const installBar = $("installBar").querySelector("i");
  const subBar = $("subBar").querySelector("i");
  const consoleEl = $("console");
  const svcBadge = $("svcBadge");
  const lockBadge = $("lockBadge");
  const attBadge = $("attBadge");
  const gpuMemBar = $("gpuMemBar").querySelector("i");
  const gpuUtilBar = $("gpuUtilBar").querySelector("i");
  const gpuMemTxt = $("gpuMemTxt");
  const gpuUtilTxt = $("gpuUtilTxt");

  let lastConsole = "";

  function setBar(el, pct) {
    el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    consoleEl.scrollTop = consoleEl.scrollHeight;
    lastConsole = consoleEl.textContent;
  }
  /** 控制台内容来自 yue:getStatus 的 consoleTail（本窗不额外开 console 事件通道）。 */
  function renderConsole(text) {
    const t = String(text || "");
    if (t === lastConsole) return;
    const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 48;
    consoleEl.textContent = t;
    lastConsole = t;
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function applyGpu(gpu) {
    if (!gpu) return;
    gpuMemTxt.textContent = `${gpu.memUsed}/${gpu.memTotal} MiB (${gpu.memPct || 0}%) · ${gpu.name || ""}`;
    gpuUtilTxt.textContent = `${gpu.util || 0}%`;
    setBar(gpuMemBar, gpu.memPct);
    setBar(gpuUtilBar, gpu.util);
  }

  async function refresh() {
    let st = null;
    try {
      st = await api.getStatus();
    } catch (e) {
      return null;
    }
    if (!st) return null;
    installDirEl.textContent = st.installDir || "未设置";
    const proj = st.project || {};
    const bits = [];
    if (proj.scaffold) bits.push("脚手架✓");
    if (proj.venv) bits.push("venv✓");
    if (proj.models) bits.push("权重✓");
    diskLine.textContent = `建议预留磁盘 ≥${st.diskHintGb || 25}GB`;
    diskHint.textContent =
      `建议预留 ≥${st.diskHintGb || 25}GB。` + (bits.length ? " 当前：" + bits.join(" · ") : " 尚未检测到完整安装。");

    const running = !!st.running || !!st.gradioUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");

    const lock = st.lock;
    if (lock && lock.nodeId) {
      lockBadge.textContent = "全局锁：" + (lock.kind === "yue_gen" ? "音乐" : lock.kind || "任务") + " 进行中";
      lockBadge.className = "badge lock";
    } else {
      lockBadge.textContent = "全局锁空闲";
      lockBadge.className = "badge off";
    }

    /* 注意力档位：探针实测 / 缓存下发给后端的档位（flash 在 Windows 轮子里没编 kernel） */
    const att = String(st.attentionBackend || "");
    if (attBadge) {
      attBadge.textContent = att ? "注意力 " + att + (att === "flash" ? "（可能在 Planning 失败）" : "") : "注意力 —";
      attBadge.className = "badge " + (att && att !== "flash" ? "on" : "off");
    }

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    $("btnCancelInstall").disabled = !st.installing;
    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;

    if (st.gpu) applyGpu(st.gpu);
    renderConsole(st.consoleTail);
    return st;
  }

  $("btnDir").onclick = async () => {
    try {
      const r = await api.pickInstallDir();
      if (r && r.ok) {
        logLine("installDir=" + r.installDir);
        if (r.project && r.project.ready) logLine("发现已有完整项目，可直接启用服务。");
      } else if (r && r.error) {
        logLine("目录无效: " + r.error);
        alert("目录无效：" + r.error + "\n请勿选择磁盘根目录或系统目录。");
      }
    } catch (e) {
      logLine("设置目录失败: " + String((e && e.message) || e));
    }
    refresh();
  };

  $("btnInstall").onclick = async () => {
    logLine("开始 Agent 安装（脚手架仅作参考）…");
    let r = null;
    try {
      r = await api.install({});
    } catch (e) {
      logLine("安装调用失败: " + String((e && e.message) || e));
      return;
    }
    /* 磁盘不足：主进程已明确回报门槛，用户确认后带 force 再来一次 */
    if (r && !r.ok && r.error === "low_disk") {
      const ok = confirm(
        `磁盘剩余约 ${r.freeGb}GB，建议预留 ≥${r.needGb}GB。\n仍要继续安装吗？`,
      );
      if (ok) {
        try {
          r = await api.install({ force: true });
        } catch (e) {
          logLine("安装调用失败: " + String((e && e.message) || e));
          return;
        }
      }
    }
    if (r && r.ok) logLine(r.recoveredByAgent ? "Agent 保底安装完成" : "Agent 安装完成");
    else if (r && r.error === "cancelled") logLine("安装已取消");
    else logLine("Agent 安装失败: " + ((r && (r.message || r.error)) || "未知错误"));
    refresh();
  };

  $("btnCancelInstall").onclick = async () => {
    try {
      await api.cancelInstall();
    } catch {}
    logLine("已请求取消安装…");
    refresh();
  };

  /** 失败出口文案：报错码 missing_dep:<name> / attention_backend_unsupported → 指明修复路径。 */
  function fmtErr(code, msg) {
    const m = String(code || "").match(/^missing_dep:(.+)$/);
    if (m) return `缺依赖 ${m[1]}（点「一键修复」或手动 pip install）`;
    if (String(code || "") === "attention_backend_unsupported") {
      return String(msg || "") || "注意力档位不可用（flash 在 Windows 轮子里没编 kernel）：已改用 cudnn/sdpa，点「一键修复」重试";
    }
    return String(msg || code || "");
  }

  $("btnStart").onclick = async () => {
    logLine("手动启动后端（调试）…");
    const r = await api.start();
    logLine(r && r.ok ? "服务已启动" + (r.port ? " :" + r.port : "") : "启动失败: " + fmtErr(r && r.error, r && r.message));
    refresh();
  };

  $("btnStop").onclick = async () => {
    const r = await api.stop();
    logLine(r && r.ok ? "服务已停止" : "关闭失败");
    refresh();
  };

  $("btnCloseWin").onclick = () => {
    if (api.closeSelf) api.closeSelf();
    else api.close();
  };

  $("btnClearLog").onclick = () => {
    consoleEl.textContent = "";
    lastConsole = "";
  };

  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "install" || ev.phase === "update") {
      installStep.textContent = (ev.stepLabel || ev.step || "") + (ev.message ? " — " + ev.message : "");
      setBar(installBar, ev.pct);
      if (ev.subPct != null) {
        subStep.textContent = "子进度 " + Math.round(ev.subPct) + "%";
        setBar(subBar, ev.subPct);
      }
      if (ev.step === "agent_recover") subStep.textContent = "Agent 保底修复中…";
    }
    if (ev.phase === "generate") {
      installStep.textContent = "生成: " + (ev.message || "");
      setBar(installBar, ev.pct || 0);
    }
  });
  api.onGpu(applyGpu);

  (async () => {
    await refresh();
    setInterval(refresh, 2500);
  })();
})();
