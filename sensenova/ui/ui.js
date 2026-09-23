(() => {
  const api = window.sensenovaApi;
  if (!api) {
    document.body.textContent = "sensenovaApi missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    badgeSvc: $("badgeSvc"),
    badgeModels: $("badgeModels"),
    badgeLock: $("badgeLock"),
    badgeAttn: $("badgeAttn"),
    badgeVram: $("badgeVram"),
    diskLine: $("diskLine"),
    gpuLine: $("gpuLine"),
    vModel: $("vModel"),
    vDir: $("vDir"),
    vState: $("vState"),
    progMsg: $("progMsg"),
    bar: $("bar"),
    subMsg: $("subMsg"),
    subBar: $("subBar"),
    log: $("log"),
    genMsg: $("genMsg"),
    outImg: $("outImg"),
    inRatio: $("inRatio"),
    gpuMemTxt: $("gpuMemTxt"),
    gpuUtilTxt: $("gpuUtilTxt"),
    gpuMemBar: $("gpuMemBar"),
    gpuUtilBar: $("gpuUtilBar"),
  };

  let lastConsole = "";
  let ratioFilled = false;
  let stCache = null;

  function setBar(node, pct) {
    if (!node) return;
    node.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    if (el.log.textContent === "（暂无日志）") el.log.textContent = "";
    el.log.textContent += String(s || "") + "\n";
    el.log.scrollTop = el.log.scrollHeight;
    lastConsole = el.log.textContent;
  }
  /** 控制台正文来自 sensenova:getStatus 的 consoleTail（本窗不开单独的 console 事件通道）。 */
  function renderConsole(text) {
    const t = String(text || "");
    if (t === lastConsole) return;
    const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 48;
    el.log.textContent = t;
    lastConsole = t;
    if (atBottom) el.log.scrollTop = el.log.scrollHeight;
  }
  function applyGpu(gpu) {
    if (!gpu) return;
    el.gpuMemTxt.textContent = `${gpu.memUsed}/${gpu.memTotal} MiB (${gpu.memPct || 0}%) · ${gpu.name || ""}`;
    el.gpuUtilTxt.textContent = `${gpu.util || 0}%`;
    setBar(el.gpuMemBar, gpu.memPct);
    setBar(el.gpuUtilBar, gpu.util);
  }
  function badge(node, text, cls) {
    if (!node) return;
    node.textContent = text;
    node.className = "badge " + (cls || "off");
  }
  /** 官方只有 11 个训练分辨率桶：下拉直接取后端 /health 的 resolutions（唯一真源） */
  function fillRatios(list) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      if (!ratioFilled) {
        el.inRatio.innerHTML = '<option value="">（启动后端后可选）</option>';
      }
      return;
    }
    const prev = el.inRatio.value;
    el.inRatio.innerHTML = arr
      .map((r) => `<option value="${r.ratio}">${r.ratio} · ${r.width}×${r.height}</option>`)
      .join("");
    if (prev && arr.some((r) => r.ratio === prev)) el.inRatio.value = prev;
    ratioFilled = true;
  }

  function applyState(st) {
    const running = !!st.running || !!st.apiUp;
    if (st.apiUp) {
      badge(el.badgeSvc, running ? "服务运行中" : "服务未响应", "on");
    } else {
      badge(el.badgeSvc, running ? "进程在但 /health 无响应" : "服务关闭", running ? "warn" : "off");
    }
    if (st.mock) badge(el.badgeSvc, "服务运行中（mock）", "mock");

    const hasModels = !!(st.project && st.project.models) || !!st.modelReady;
    badge(el.badgeModels, hasModels ? "权重 ✓ 32.66GB" : "权重未就绪", hasModels ? "on" : "warn");

    const lock = st.lock;
    if (lock && lock.nodeId) {
      const label = lock.kind === "sensenova_gen" ? "图像" : lock.kind || "任务";
      badge(el.badgeLock, "全局锁：" + label + " 进行中", "warn");
    } else {
      badge(el.badgeLock, "全局锁空闲", "off");
    }

    const att = String(st.effectiveAttnBackend || "");
    badge(el.badgeAttn, att ? "注意力 " + att : "注意力 —", att && att !== "flash" ? "on" : att === "flash" ? "warn" : "off");

    badge(el.badgeVram, "显存 " + (st.vramMode || "fast"), (Number(st.maxVramGb) || 24) >= 24 ? "on" : "warn");

    el.vModel.textContent = (st.model || "—") + (st.packageVersion ? "（推理包 v" + st.packageVersion + "）" : "");
    el.vDir.textContent = st.installDir || "未设置";
    const proj = st.project || {};
    const bits = [];
    if (proj.scaffold) bits.push("脚手架✓");
    if (proj.venv) bits.push("venv✓");
    if (proj.models) bits.push("权重✓");
    if (proj.installed) bits.push("冒烟✓");
    const stateBits = ["安装目录：" + (st.installDir || "未设置")];
    if (bits.length) stateBits.push("当前：" + bits.join(" · "));
    if (st.loaded) stateBits.push("权重已加载进内存");
    if (st.missingDeps && st.missingDeps.length) stateBits.push("缺依赖：" + st.missingDeps.join(","));
    if (!st.supported) stateBits.push("本机显存 / 显卡不满足门槛（见安装提示）");
    el.vState.textContent = stateBits.join(" — ");

    el.diskLine.textContent = `建议预留磁盘 ≥${st.diskHintGb || 60}GB`;
    const g = st.gpu && st.gpu.gpus && st.gpu.gpus[0];
    el.gpuLine.textContent = g
      ? `显卡 ${g.name} · 显存 ${Math.round((g.memTotalMb || 0) / 1024)}GB · 驱动 ${g.driver || "?"}`
      : "显卡 未检测到 NVIDIA";

    $("btnDir").disabled = false;
    $("btnInstall").disabled = !st.installDir || !!st.installing;
    $("btnAgentInstall").disabled = !st.installDir || !!st.installing;
    $("btnCancel").disabled = !st.installing;
    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;
    $("btnForceKill").disabled = !running;
    $("btnGen").disabled = !st.installDir || !!st.installing;
    $("btnGenCancel").disabled = !st.busyNode;
    if (st.idleMinutes != null) $("inIdle").value = String(st.idleMinutes);
    if (st.vramMode != null && $("inVramMode").value !== String(st.vramMode)) {
      $("inVramMode").value = String(st.vramMode || "");
    }
    $("inForce").checked = !!st.forceHardware;
    fillRatios(st.resolutions);
    /* status.gpu 是 { hasNvidia, gpus[], maxVramGb }，与 onGpu 推的单帧采样不同形，这里折算一次 */
    const g0 = st.gpu && st.gpu.gpus && st.gpu.gpus[0];
    if (g0) {
      applyGpu({
        name: g0.name,
        memUsed: g0.memUsedMb,
        memTotal: g0.memTotalMb,
        util: g0.util,
        memPct: g0.memTotalMb > 0 ? Math.round((g0.memUsedMb / g0.memTotalMb) * 1000) / 10 : 0,
      });
    }
    renderConsole(st.consoleTail);
  }

  async function refresh() {
    let st = null;
    try {
      st = await api.getStatus();
    } catch {
      return null;
    }
    if (!st) return null;
    stCache = st;
    applyState(st);
    return st;
  }

  /* ───────── 目录 ───────── */
  $("btnDir").onclick = async () => {
    try {
      const r = await api.pickInstallDir();
      if (r && r.ok) {
        logLine("installDir=" + r.installDir);
        if (r.project && r.project.ready) logLine("发现已有项目，可直接安装补齐 / 启动服务。");
      } else if (r && r.error) {
        const why =
          r.error === "refuse_root"
            ? "不能选磁盘根目录"
            : r.error === "refuse_system"
              ? "不能选系统目录（Windows / Program Files）"
              : r.error === "refuse_app_dir"
                ? "不能选应用安装目录（升级会覆盖，数据必须留在别处）"
                : r.error;
        logLine("目录无效: " + why);
        alert("目录无效：" + why + "\n请在数据盘上新建一个空目录，例如 E:\\dev\\sensenova。");
      }
    } catch (e) {
      logLine("设置目录失败: " + String((e && e.message) || e));
    }
    refresh();
  };

  /* ───────── 安装 ───────── */
  async function runInstall(fn, label) {
    logLine(label + "…（32.66GB 权重视带宽约 20–60 分钟，请耐心等待，不要关窗）");
    let r = null;
    try {
      r = await fn({});
    } catch (e) {
      logLine("安装调用失败: " + String((e && e.message) || e));
      return;
    }
    /* 磁盘不够：主进程给了明确门槛，用户确认后带 force 再来一次 */
    if (r && !r.ok && r.error === "low_disk") {
      if (!confirm(`磁盘剩余约 ${r.freeGb}GB，建议预留 ≥${r.needGb}GB。\n仍要继续安装吗？`)) {
        logLine("已取消：请先清理磁盘或换一个目录。");
        refresh();
        return;
      }
      try {
        r = await fn({ force: true });
      } catch (e) {
        logLine("安装调用失败: " + String((e && e.message) || e));
        return;
      }
    }
    /* 硬件门槛被拒：说明原因 + 指路（勾选「忽略硬件门槛」才允许硬闯） */
    if (r && !r.ok && (r.error === "vram_too_low" || r.error === "ram_too_low" || r.error === "no_cuda")) {
      logLine("安装被拒：" + (r.message || r.error));
      alert(String(r.message || r.error));
      refresh();
      return;
    }
    if (r && r.ok) logLine(r.recoveredByAgent ? "Agent 保底安装完成" : r.via === "agent" ? "Agent 安装完成" : "安装完成（脚本快路径）");
    else if (r && r.error === "cancelled") logLine("安装已取消");
    else logLine("安装失败: " + ((r && (r.message || r.error)) || "未知错误") + "\n可点「交给 AI 安装」按 skill 继续修复。");
    refresh();
  }
  $("btnInstall").onclick = () => runInstall(api.install, "脚本安装（venv + CUDA torch + 推理包 + 权重 + mock 冒烟）");
  $("btnAgentInstall").onclick = () => runInstall((o) => api.install(Object.assign({ mode: "agent" }, o || {})), "Agent 安装");
  $("btnCancel").onclick = async () => {
    try {
      await api.cancelInstall();
    } catch {}
    logLine("已请求取消安装…");
    refresh();
  };

  /* ───────── 后端启停 ───────── */
  function fmtErr(code, msg) {
    const c = String(code || "");
    if (/^missing_dep/.test(c)) return "缺依赖：" + c.replace(/^missing_dep:?/, "") + "（点「交给 AI 安装」修复）";
    if (c === "torch_cpu_build") return String(msg || "torch 是 CPU 版") + "：SenseNova 需要 CUDA 版 torch";
    if (c === "no_cuda") return "未检测到 NVIDIA 显卡，本地图像生成不可用（可改用云端「文生图」节点）";
    if (c === "vram_too_low") return "显存不足门槛（需 ≥20GB，24GB 档走 fast）：请降低占用或改用云端「文生图」节点";
    if (c === "model_load_failed") return "权重加载失败：先确认安装目录 models\\ 下 8 片 safetensors 齐全";
    if (c === "port_in_use") return "端口被占用：改端口或先停掉占用 8774 的进程";
    return String(msg || c || "");
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
  $("btnForceKill").onclick = async () => {
    if (!confirm("立即结束后台进程？\n已加载的 32.66GB 权重会全部释放，下次生成需重新加载（几分钟）。")) return;
    const r = await api.forceKill("console_button");
    logLine(r && r.ok ? "已强制结束后端，显存与主内存已释放" : "强制结束失败");
    refresh();
  };
  $("btnCloseWin").onclick = () => {
    if (api.closeSelf) api.closeSelf();
    else api.close();
  };
  $("btnClearLog").onclick = () => {
    el.log.textContent = "";
    lastConsole = "";
  };

  /* ───────── 试生成 ───────── */
  $("btnGen").onclick = async () => {
    const prompt = String($("inPrompt").value || "").trim();
    if (!prompt) {
      alert("先写提示词。");
      return;
    }
    const params = {
      nodeId: "console-" + Date.now(),
      prompt,
      ratio: $("inRatio").value || undefined,
      numSteps: Number($("inSteps").value) || 50,
      cfgScale: Number($("inCfg").value),
      seed: Number($("inSeed").value) || 0,
      think: $("inThink").checked,
    };
    el.genMsg.textContent = "生成中（首次要加载权重，可能几分钟）…";
    $("btnGen").disabled = true;
    $("btnGenCancel").disabled = false;
    let r = null;
    try {
      r = await api.generate(params);
    } catch (e) {
      r = { ok: false, error: "ipc_failed", message: String((e && e.message) || e) };
    }
    $("btnGen").disabled = false;
    $("btnGenCancel").disabled = true;
    if (r && r.ok) {
      const w = (Number(r.elapsedSec) || 0).toFixed(1);
      el.genMsg.textContent =
        `✅ ${r.width}×${r.height} · seed=${r.seed} · ${w}s` +
        (r.peakVramGiB ? ` · 峰值显存 ${r.peakVramGiB}GiB` : "") +
        (r.vramMode ? ` · ${r.vramMode}` : "") +
        (r.mock ? " · mock 占位图" : "") +
        ((r.warnings && r.warnings.length) ? " · 警告：" + r.warnings.join("；") : "");
      logLine("生成完成 " + r.path);
      el.outImg.style.display = "block";
      /* # 是 URL 的片段分隔符：产物名现在带 take 编号（x#1.png），必须逐段百分号编码 */
      el.outImg.src =
        "file:///" +
        String(r.path)
          .replace(/\\/g, "/")
          .replace(/^\/+/, "")
          .split("/")
          .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
          .join("/") +
        "?t=" +
        Date.now();
      if ($("inSeed")) $("inSeed").value = String(r.nextSeed || r.seed || 0);
    } else {
      el.genMsg.textContent = "❌ " + fmtErr(r && r.error, r && r.message);
      logLine("生成失败: " + ((r && (r.message || r.error)) || "未知错误"));
    }
    refresh();
  };
  $("btnGenCancel").onclick = async () => {
    await api.cancelGenerate((stCache && stCache.busyNode) || "");
    el.genMsg.textContent = "已请求取消（在下一个采样步边界生效）…";
  };

  /* ───────── 设置 ───────── */
  $("btnSaveCfg").onclick = async () => {
    const patch = {
      vramMode: $("inVramMode").value || "",
      forceHardware: !!$("inForce").checked,
    };
    /* 空闲释放分钟：只在输入框有合法数字时才下发。
       历史上这里是 `Number($("inIdle").value) || 0`：输入框为空 / 状态还没回填时点保存，
       会静默把 idleMinutes 写成 0 —— 那正是「0 = 永不释放」，于是生成完成后显存一直不还。
       空值 / 非法值一律不下发，保留后端当前值；越界由主进程 setConfig 夹取。 */
    const idleRaw = String($("inIdle").value == null ? "" : $("inIdle").value).trim();
    const idleNum = idleRaw === "" ? NaN : Number(idleRaw);
    if (Number.isFinite(idleNum)) patch.idleMinutes = Math.round(idleNum);
    const r = await api.setConfig(patch);
    if (r && r.ok) {
      if (patch.idleMinutes == null)
        $("cfgMsg").textContent = "已保存（空闲释放分钟未填，保持原值）";
      else $("cfgMsg").textContent = "已保存";
    } else {
      $("cfgMsg").textContent = "保存失败：" + ((r && r.error) || "");
    }
    if (r && r.ok) {
      logLine(
        "设置已保存：vramMode=" + (patch.vramMode || "后端默认") +
          " · 空闲释放=" +
          (patch.idleMinutes == null ? "保持原值" : patch.idleMinutes + " 分钟") +
          (patch.forceHardware ? " · 已允许忽略硬件门槛" : ""),
      );
      if (patch.idleMinutes === 0)
        logLine("提示：空闲释放 = 0 表示**永不自动释放**后端（显存会被一直占着）");
    }
    refresh();
  };

  /* ───────── 进度回推 ───────── */
  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "install") {
      el.progMsg.textContent = (ev.stepLabel || ev.step || "") + (ev.message ? " — " + ev.message : "");
      setBar(el.bar, ev.pct);
      if (ev.subPct != null) {
        el.subMsg.textContent = "子进度 " + Math.round(ev.subPct) + "%";
        setBar(el.subBar, ev.subPct);
      }
      if (ev.step === "agent_recover") el.subMsg.textContent = "脚本安装失败，Agent 正在保底修复…";
    } else if (ev.phase === "runtime") {
      el.progMsg.textContent = ev.message || "";
      setBar(el.bar, ev.pct);
    } else if (ev.phase === "generate") {
      const step = ev.totalSteps ? ` 步 ${ev.step}/${ev.totalSteps}` : "";
      el.genMsg.textContent = `${ev.message || "生成中"}${step} ${Math.round(ev.pct || 0)}%` +
        (ev.elapsedSec ? ` · ${ev.elapsedSec.toFixed ? ev.elapsedSec.toFixed(0) : ev.elapsedSec}s` : "");
      setBar(el.bar, ev.pct);
      el.subMsg.textContent = ev.stage ? "阶段 " + ev.stage : "";
    }
  });
  api.onGpu(applyGpu);

  (async () => {
    await refresh();
    setInterval(refresh, 2500);
  })();
})();
