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
  const wfModal = $("wfModal");
  /* 右上角那两个按钮的句柄在这里一次取齐：refresh() 要读 comfyBtn 亮状态，
     事件绑定在下面很远的位置——const 有 TDZ，声明晚于首次调用就会炸。 */
  const paneEl = $("consolePane");
  const paneBtn = $("btnConsolePane");
  const cbadgeEl = $("cbadge");
  const comfyBtn = $("btnOpenComfy");
  /* 工作流编辑器视图（内嵌 ComfyUI）的那几个控件同样在这里一次取齐，理由同上。 */
  const wfEditorEl = $("wfEditor");
  const wfEditorFrame = $("wfEditorFrame");
  const wfEditorTitleEl = $("wfEditorTitle");
  const wfEditorSrcEl = $("wfEditorSrc");
  const wfEditorNoteEl = $("wfEditorNote");
  const wfEditorCloseBtn = $("btnWfEditorClose");

  /* ───── 左侧 Console 停靠面板 ─────
   * 面板本身只负责显示 console 内容；位置与「等高」由 body 的 flex 布局保证。
   * 窗口宽度归宿主管：这里量出面板实际像素宽度报给 setConsolePane，宿主按这个数把
   * 窗口往左撑 / 收（右边缘不动）→ 右侧主列一格都不会挪。绝不把宽度在两边各写一遍，
   * 免得 CSS 一改就和窗口宽度对不上。 */
  const PANE_STORE_KEY = "h3.consolePaneOpen";
  let paneOpen = false;
  let paneUnread = 0;

  function paneStored() {
    try {
      return localStorage.getItem(PANE_STORE_KEY) === "1";
    } catch {
      return false;
    }
  }
  function paneStore(on) {
    try {
      localStorage.setItem(PANE_STORE_KEY, on ? "1" : "0");
    } catch {}
  }
  function renderBadge() {
    if (!cbadgeEl) return;
    cbadgeEl.hidden = !(!paneOpen && paneUnread > 0);
    cbadgeEl.textContent = paneUnread > 99 ? "99+" : String(paneUnread);
  }
  async function setPaneOpen(on) {
    const want = !!on;
    if (paneOpen === want) return;
    paneOpen = want;
    if (paneEl) paneEl.hidden = !want;
    if (paneBtn) paneBtn.classList.toggle("on", want);
    if (want) {
      paneUnread = 0;
      renderBadge();
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
    paneStore(want);
    if (!api.setConsolePane) return;
    /* 上面已摘掉 hidden，此刻才量得到宽度（hidden 时 offsetWidth = 0） */
    const width = want && paneEl ? paneEl.offsetWidth : 0;
    try {
      await api.setConsolePane({ open: want, width });
    } catch (e) {
      logLine("[pane] 宿主调整窗口失败: " + String((e && e.message) || e));
    }
  }

  /* 弹窗显隐只靠 CSS 类太脆（.modal-bg 样式被误删过一次，两个弹窗直接常驻页面底部，
     点「取消」只是摘掉一个没人认的 class —— 看起来就是「关不掉的卸载窗口」）。
     这里同时用 hidden 属性 + 内联 display 兜底：样式表再怎么改都关得掉。 */
  function openModal(el) {
    if (!el) return;
    el.hidden = false;
    el.classList.add("show");
    el.style.display = "flex";
  }
  function closeModal(el) {
    if (!el) return;
    el.classList.remove("show");
    el.style.display = "none";
    el.hidden = true;
  }
  function modalIsOpen(el) {
    return !!el && !el.hidden;
  }
  /* 兜底关闭通道：Esc 关掉当前开着的弹窗；点遮罩空白处（不是弹窗本体）也关掉 */
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    /* 编辑器视图不参与 Esc：里面是用户正在 ComfyUI 里编辑的现场，手一抖就整窗关掉太伤，
       关闭只走浮层上那个 ✕。 */
    if (wfEditorEl && !wfEditorEl.hidden) return;
    if (modalIsOpen(wfModal)) closeModal(wfModal);
    else if (modalIsOpen(modal)) closeModal(modal);
  });
  for (const el of [modal, wfModal]) {
    if (!el) continue;
    el.addEventListener("pointerdown", (ev) => {
      if (ev.target === el) closeModal(el);
    });
  }

  function setBar(el, pct) {
    el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    if (paneOpen) consoleEl.scrollTop = consoleEl.scrollHeight;
    /* 面板收起时新行不白丢：按钮上挂未读数，点开即清零 */
    else {
      paneUnread = Math.min(999, paneUnread + 1);
      renderBadge();
    }
  }

  async function refresh() {
    const st = await api.getStatus();
    installDirEl.textContent = st.installDir || "未设置";
    const proj = st.project || {};
    const bits = [];
    if (proj.scaffold) bits.push("脚手架✓");
    if (proj.venv) bits.push("venv✓");
    if (proj.models) bits.push("模型✓");
    if (proj.hasPost) bits.push("4K后处理✓");
    else if (proj.venv) bits.push("4K后处理待装");
    diskHint.textContent =
      `建议预留 ≥${st.diskHintGb || 70}GB。` +
      (bits.length ? " 当前：" + bits.join(" · ") : " 尚未检测到完整安装。");

    const running = !!st.running || !!st.comfyUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");
    /* 按钮条左半边：把 ComfyUI 地址常驻亮出来（一键打开时用户知道会开到哪儿） */
    const port = Number(st.port) || 8188;
    const url = st.comfyUrl || "http://127.0.0.1:" + port + "/";
    const hint = $("comfyHint");
    if (hint) {
      hint.textContent = (running ? "● " : "○ ") + "ComfyUI :" + port;
      hint.title = url + "（后端只监听本机，浏览器同机打开）";
    }
    if (comfyBtn) {
      comfyBtn.title = running
        ? "在浏览器打开 " + url
        : "后端未运行 · 点了会先问你是否启动 " + url;
      comfyBtn.classList.toggle("on", running);
    }

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    if ($("btnSelfRepair")) $("btnSelfRepair").disabled = !st.installDir || !!st.installing;
    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;
    $("btnUninstall").disabled = !st.installDir || !!st.installing;

    if (st.gpu) applyGpu(st.gpu);
    renderSage(st);
    syncLaunchOptsUi(st);
    return st;
  }

  /* ── Sage Attention（注意力加速）状态 ─────────────────────────────
   * 主进程在 venv 里真探一次（triton 与 sageattention 必须成对：sageattention 的 core
   * 在 import 期就拉 Triton kernel），结果带缓存。缺包**不是故障**——生成会自动跳过这一档
   * 优化，只是慢约 1.5-2×；所以这里只报事实 + 给出「Sage 加速」这一键
   * （点了先自检，确认可补才装；已就绪时原样回执，不会重复写盘）。 */
  function renderSage(st) {
    const info = st.sage || {};
    const hasVenv = !!(st.project && st.project.venv);
    const btn = $("btnSage");
    if (btn) {
      btn.disabled = !hasVenv || !!st.installing;
      btn.classList.toggle("on", !!info.ok);
      btn.title = info.ok
        ? "已就绪：sageattention " + info.sage + " + triton " + info.triton + "（再点一次只复核，不重装）"
        : "自检注意力加速包（triton-windows + sageattention 预编译 wheel）：未装就一键补装。缺包不影响出片，只是慢约 1.5-2×";
    }
    const el = $("sageInfo");
    if (!el) return;
    if (!hasVenv) el.textContent = "Sage Attention：待后端装好后再自检（先点「安装」）";
    else if (!info.probed) el.textContent = "Sage Attention：自检中…（在 venv 里 import 一次，几秒）";
    else if (info.ok)
      el.textContent =
        "Sage Attention ✓ 已装：sageattention " + info.sage + " · triton " + info.triton + " · " + (info.sm || "?") + " → 注意力加速生效";
    else
      el.textContent =
        "Sage Attention 未就绪（" + (info.why || "缺包") + "）：生成会自动跳过这一档优化，慢约 1.5-2×。点「Sage 加速」补装。";
  }

  function syncLaunchOptsUi(st) {
    const map = [
      ["optCpuVae", st.cpuVae !== false],
      ["optPinned", st.optDisablePinnedMemory !== false],
      ["optFp16", st.optFp16Intermediates !== false],
      ["optExpand", st.optExpandableSegments !== false],
    ];
    for (const [id, on] of map) {
      const el = $(id);
      if (el && !el._bound) {
        el._bound = true;
        el.addEventListener("change", async () => {
          if (!api.setLaunchOpts) return;
          const r = await api.setLaunchOpts({
            cpuVae: !!$("optCpuVae").checked,
            optDisablePinnedMemory: !!$("optPinned").checked,
            optFp16Intermediates: !!$("optFp16").checked,
            optExpandableSegments: !!$("optExpand").checked,
          });
          const note = $("launchOptsNote");
          if (note) note.textContent = (r && r.note) || "已保存";
          logLine("启动优化已保存（下次启动生效）");
        });
      }
      if (el) el.checked = !!on;
    }
  }

  function applyGpu(gpu) {
    if (!gpu) return;
    const fmt = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v) + unit);
    const mem =
      gpu.memUsed != null || gpu.memTotal != null
        ? fmt(gpu.memUsed, "") + "/" + fmt(gpu.memTotal, "") + " MiB"
        : "—";
    const pct = gpu.memPct == null ? "" : " (" + gpu.memPct + "%)";
    gpuMemTxt.textContent = mem + pct + (gpu.name ? " · " + gpu.name : "");
    gpuUtilTxt.textContent = fmt(gpu.util, "%");
    setBar(gpuMemBar, gpu.memPct);
    setBar(gpuUtilBar, gpu.util);
  }

  $("btnDir").onclick = async () => {
    const r = await api.pickInstallDir();
    if (r && r.ok) {
      logLine("installDir=" + r.installDir);
      if (r.project && r.project.ready) logLine("发现已有完整项目，可直接点「手动启动」。");
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

  $("btnSelfRepair").onclick = async () => {
    if (!api.selfRepair) {
      logLine("当前版本不支持自我修复");
      return;
    }
    const ok = confirm(
      "自我修复会把最近的 console 日志交给 Agent（dsh）分析判断并动手修复。\n每人环境不同，由 Agent 根据日志自行决策。不会启动服务。\n继续？",
    );
    if (!ok) return;
    logLine("自我修复：提交 console → dsh…");
    const r = await api.selfRepair({});
    if (r && r.ok) {
      logLine("自我修复完成" + (r.message ? " — " + r.message : ""));
    } else
      logLine(
        "自我修复失败: " +
          ((r && (r.message || r.error)) || "未知错误") +
          (r && r.consoleBytes != null ? " · log≈" + r.consoleBytes + "B" : ""),
      );
    refresh();
  };

  $("btnSage").onclick = async () => {
    if (!api.installSage) {
      logLine("当前版本不支持 Sage 自检 / 补装");
      return;
    }
    logLine("Sage 加速：先在 venv 里自检（triton + sageattention），缺则补装…");
    const r = await api.installSage({});
    if (r && r.ok) logLine("[sage] " + ((r && r.message) || "已就绪"));
    else
      logLine(
        "[sage] 未就绪: " +
          ((r && (r.message || r.error)) || "未知错误") +
          "（缺它只影响速度，不影响出片；也可点「自我修复」让 Agent 代装）",
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
      "强制结束后端并释放显存？\n适用于 GPU 跑满却永远不结束的情况。\n之后需重新点「手动启动」。",
    );
    if (!ok) return;
    logLine("强制释放显存…");
    const r = await api.forceKillBackend();
    logLine(r && r.ok ? "已结束后端，显存应已释放；请重新点「手动启动」" : "失败: " + ((r && r.error) || ""));
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
    openModal(modal);
  };

  $("btnCancelUn").onclick = () => closeModal(modal);
  $("btnConfirmUn").onclick = async () => {
    closeModal(modal);
    $("installStep").textContent = "正在卸载（大目录可能要几分钟）…";
    const r = await api.uninstall({
      confirm: true,
      deleteOutput: !!$("delOutput").checked,
    });
    logLine(r && r.ok ? "卸载完成（安装目录配置已保留，便于再次发现）" : "卸载失败: " + ((r && r.error) || ""));
    refresh();
  };

  if ($("btnClearLog"))
    $("btnClearLog").onclick = () => {
      consoleEl.textContent = "";
      paneUnread = 0;
      renderBadge();
    };

  /* ───── 右上角：Console 面板开关 + ComfyUI 编辑界面 ───── */
  if (paneBtn) paneBtn.onclick = () => setPaneOpen(!paneOpen);
  if ($("btnClosePane")) $("btnClosePane").onclick = () => setPaneOpen(false);

  async function openComfyUi(start) {
    if (!api.openComfyUI) {
      logLine("当前宿主不支持一键打开 ComfyUI 编辑界面");
      return;
    }
    if (comfyBtn) comfyBtn.disabled = true;
    try {
      const r = await api.openComfyUI({ start: !!start });
      if (r && r.ok) {
        logLine("[comfy] 已打开编辑界面 " + (r.url || ""));
        return;
      }
      const err = (r && (r.error || r.message)) || "未知错误";
      if (r && r.error === "backend_not_running") {
        const url = (r && r.url) || "";
        if (start) {
          logLine("[comfy] 后端起来了但界面没应答（可能还在加载）：" + url + " · " + err);
          return;
        }
        if (!confirm("ComfyUI 后端现在没在运行，" + url + " 打不开。\n\n现在启动后端并打开编辑界面吗？\n（首次加载模型可能要几分钟，期间可继续用其它功能）"))
          return;
        logLine("[comfy] 启动后端并打开编辑界面…");
        await openComfyUi(true);
        return;
      }
      logLine("[comfy] 打开失败: " + err + ((r && r.message) ? " — " + r.message : ""));
    } finally {
      if (comfyBtn) comfyBtn.disabled = false;
      refresh();
    }
  }
  if (comfyBtn) comfyBtn.onclick = () => openComfyUi(false);

  /* ───── 工作流编辑器视图（管理窗内嵌 ComfyUI）─────
   * 状态真源在宿主（open / url / id / title / file / loaded / hint，见 main-h3.js 的 wfEditorView），
   * 本页面只当容器：宿主把窗口撑大、把这条模板推给 ComfyUI 前端，这里负责挂摘浮层、
   * 给 iframe 换 src、把「没能自动载入」的中文提示常驻亮出来。
   * persistent 面板：关闭只走浮层上那个 ✕，不挂「点外部 / 失焦即关」（Esc 也在上面让开了）。
   * 关浮层时不摘 iframe 的 src —— 用户正在 ComfyUI 里编辑的图不能被我们刷没，
   * 再开同一条模板时应当直接回到现场。 */
  let wfEditorFrameUrl = "";

  function applyWfEditorView(v) {
    const view = v || {};
    if (!wfEditorEl) return;
    if (!view.open) {
      wfEditorEl.hidden = true;
      return;
    }
    const url = String(view.url || "");
    if (url && wfEditorFrame && wfEditorFrameUrl !== url) {
      wfEditorFrame.src = url;
      wfEditorFrameUrl = url;
    }
    wfEditorEl.hidden = false;
    if (wfEditorTitleEl) wfEditorTitleEl.textContent = "工作流编辑器 · " + (view.title || "未命名");
    if (wfEditorSrcEl) {
      wfEditorSrcEl.textContent = url + (view.loaded ? " · 已载入这条模板" : "");
      wfEditorSrcEl.title = "编辑发生在 ComfyUI 自己的现场里，不会写回插件库；收回库的唯一入口是「导入 JSON」";
    }
    /* 没自动灌进画布时，宿主的提示（含要在 Workflow › Open 里选的文件名）必须亮着，别让人对着空画布猜 */
    const note = view.loaded ? "" : String(view.hint || view.error || "");
    if (wfEditorNoteEl) {
      wfEditorNoteEl.textContent = note;
      wfEditorNoteEl.hidden = !note;
    }
  }

  /** 「打开」库里这条模板：start=true 表示用户已确认可以顺手把后端拉起来。 */
  async function openWfInEditor(it, start) {
    if (!api.wfOpenInEditor) {
      logLine("当前宿主不支持在工作流库里打开模板（缺 wfOpenInEditor）");
      return;
    }
    const r = await api.wfOpenInEditor({ id: it.id, start: !!start });
    if (r && r.ok) {
      logLine(
        "[wf-editor] 打开「" + (it.title || "") + "」→ " + (r.url || "") +
          (r.loaded ? " · 已自动载入这条模板" : " · 需在工作流列表里手动选文件"),
      );
      if (r.hint) logLine("[wf-editor] " + r.hint);
      /* 正常路径宿主会推状态；成功返回这里再兜一次，某条路径漏推时浮层也出得来 */
      applyWfEditorView({
        open: true,
        url: r.url,
        title: r.title,
        file: r.file,
        loaded: r.loaded,
        hint: r.hint,
        error: r.error,
      });
      return;
    }
    const err = (r && (r.error || r.message)) || "未知错误";
    if (r && r.error === "backend_not_running") {
      if (start) {
        logLine("[wf-editor] 后端起来了但界面没应答（可能还在加载）：" + ((r && r.url) || "") + " · " + err);
        return;
      }
      /* 与右上角「ComfyUI 编辑界面」同一口径：后端没跑就先问用户要不要顺手启动 */
      if (!confirm("ComfyUI 后端现在没在运行，" + ((r && r.url) || "") + " 打不开。\n\n现在启动后端并打开这条模板吗？\n（首次加载模型可能要几分钟，期间可继续用其它功能）"))
        return;
      logLine("[wf-editor] 启动后端并打开「" + (it.title || "") + "」…");
      await openWfInEditor(it, true);
      return;
    }
    logLine("[wf-editor] 打开失败: " + err + ((r && r.message) ? " — " + r.message : ""));
  }

  if (wfEditorCloseBtn) {
    wfEditorCloseBtn.onclick = async () => {
      wfEditorCloseBtn.disabled = true;
      try {
        if (api.wfEditorClose) await api.wfEditorClose();
        else if (wfEditorEl) wfEditorEl.hidden = true; /* 旧宿主：至少自己把浮层收掉 */
      } catch (e) {
        logLine("[wf-editor] 关闭失败: " + String((e && e.message) || e));
      } finally {
        wfEditorCloseBtn.disabled = false;
      }
      logLine("[wf-editor] 编辑器视图已关闭（ComfyUI 里的改动不会进库；要收回库请「导出 JSON」后「导入 JSON」）");
    };
  }

  /* ───── 自建工作流库 ───── */
  const wfListEl = $("wfList");
  const wfStatsTxt = $("wfStatsTxt");
  if (!$("btnWfImport")) logLine("当前版本不支持自建工作流库（缺少控件）");

  function wfValBadge(v) {
    if (!v || !v.status || v.status === "unchecked")
      return { cls: "", text: "未校验" };
    if (v.status === "ok") return { cls: "ok", text: "校验通过" };
    if (v.status === "missing_nodes") {
      const m = Array.isArray(v.missing) ? v.missing : [];
      const names = m.slice(0, 3).map((x) => x.class_type).filter(Boolean).join("、");
      return {
        cls: "warn",
        text: "缺 " + m.length + " 个节点包" + (names ? "（" + names + (m.length > 3 ? "…" : "") + "）" : ""),
      };
    }
    if (v.status === "skipped") return { cls: "", text: "未校验（后端未运行）" };
    return { cls: "warn", text: (v.error || "校验异常") };
  }

  function renderWfItem(it) {
    const box = document.createElement("div");
    box.className = "wf-item";
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = it.title || "未命名";
    head.appendChild(title);
    const fmt = document.createElement("span");
    fmt.className = "badge";
    fmt.textContent = it.format === "ui" ? "UI" : "API";
    fmt.title = it.source && it.source.template ? "内置模板" : "来源：" + ((it.source && it.source.name) || "");
    if (it.source && it.source.template) fmt.textContent += " 模板";
    head.appendChild(fmt);
    const vb = wfValBadge(it.validation);
    const badge = document.createElement("span");
    badge.className = "badge " + vb.cls;
    badge.textContent = vb.text;
    head.appendChild(badge);
    const src = document.createElement("span");
    src.className = "meta";
    src.style.marginLeft = "auto";
    src.textContent = "节点 " + (it.nodeCount || 0);
    head.appendChild(src);
    box.appendChild(head);

    const outs = Array.isArray(it.outputs) ? it.outputs : [];
    if (outs.length) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        "输出：" +
        outs
          .slice(0, 3)
          .map((o) => (isVideoClass(o.classType) ? "🎬" : "📄") + " " + (o.classType || "?") + "(@" + o.nodeId + ")")
          .join("  ") +
        (outs.length > 3 ? " …" : "");
      box.appendChild(meta);
    }

    const ops = document.createElement("div");
    ops.className = "ops";
    const mkBtn = (label, fn, cls) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = async (ev) => {
        ev.stopPropagation();
        await fn();
        refreshWf();
      };
      ops.appendChild(b);
      return b;
    };
    /* 每条模板的「打开」：进管理窗内嵌的 ComfyUI 编辑这一条。
       单向 —— 库里这条记录一点不动，改完想回库只能「导出 JSON → 导入 JSON」。 */
    const openBtn = mkBtn("打开", async () => {
      openBtn.disabled = true; /* 后端冷启动可能要几分钟，期间别让人重复点 */
      try {
        await openWfInEditor(it, false);
      } finally {
        openBtn.disabled = false;
      }
    }, "primary");
    openBtn.title = "在 ComfyUI 编辑器里打开「" + (it.title || "") + "」进行修改（后端没跑会先问你是否启动）。编辑不会覆盖库里这条模板，收回库请导入 JSON。";
    mkBtn("重新校验", async () => {
      const r = await api.wfValidate(it.id);
      logLine(r && r.message ? "[校验] " + r.message : "[校验] 失败: " + ((r && r.error) || ""));
    });
    mkBtn("导出 JSON", () => wfExport(it.id));
    mkBtn("复制 JSON", async () => {
      const r = await api.wfExport(it.id);
      if (!r || !r.ok) {
        alert("导出失败：" + ((r && r.error) || "未知错误"));
        return;
      }
      try {
        await navigator.clipboard.writeText(r.text);
        logLine("已复制 " + r.filename + " 到剪贴板");
      } catch (e) {
        alert("复制失败：" + String((e && e.message) || e));
      }
    });
    mkBtn("重命名", async () => {
      const next = prompt("新名称：", it.title || "");
      if (next == null || !String(next).trim()) return;
      const r = await api.wfRename(it.id, String(next).trim());
      if (!r || !r.ok) alert("重命名失败：" + ((r && r.error) || "未知错误"));
      else logLine("已重命名 → " + (r.title || ""));
    });
    mkBtn("删除", async () => {
      if (!confirm('删除工作流「' + (it.title || "") + '」？此操作不可恢复。')) return;
      const r = await api.wfDelete(it.id);
      if (r && r.ok) logLine("已删除 " + (r.title || it.title));
      else alert("删除失败：" + ((r && r.error) || "未知错误"));
    }, "danger");
    box.appendChild(ops);
    return box;
  }

  function isVideoClass(cls) {
    return /(SaveVideo|SaveWebM|SaveMP4|VideoCombine|SaveAnimated|VHS_VideoCombine|SaveVideoFFmpeg|StoreVideo)/i.test(String(cls || ""));
  }

  async function refreshWf() {
    try {
      const r = await api.wfList();
      if (!r || !r.ok) throw new Error((r && r.error) || "wfList failed");
      wfStatsTxt.textContent =
        r.stats ? "· 共 " + r.stats.count + " 条（校验通过 " + r.stats.validated + "，缺节点 " + r.stats.warn + "，未校验 " + r.stats.unchecked + "）" : "";
      wfListEl.innerHTML = "";
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "wf-empty";
        empty.textContent = "还没有自定义工作流。导入 ComfyUI 导出的 JSON，或用「内置图另存」起步。";
        wfListEl.appendChild(empty);
        return;
      }
      for (const it of items) wfListEl.appendChild(renderWfItem(it));
    } catch (e) {
      logLine("[wf] 列表加载失败: " + String((e && e.message) || e));
    }
  }

  async function wfImportPayload(payload) {
    logLine("导入工作流…");
    const r = await api.wfImport(payload);
    if (r && r.ok) {
      logLine(
        "导入完成：" + (r.summary && r.summary.title) +
          (r.replaced ? "（已覆盖同名旧版本）" : "") +
          ((r.warnings && r.warnings.length) ? " · 提示：" + r.warnings.join("；") : ""),
      );
    } else {
      alert("导入失败：" + ((r && r.error) || "未知错误"));
    }
    refreshWf();
  }

  async function wfExport(id) {
    const r = await api.wfExport(id);
    if (!r || !r.ok) {
      alert("导出失败：" + ((r && r.error) || "未知错误"));
      return;
    }
    try {
      const blob = new Blob([r.text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      logLine("已生成导出文件 " + r.filename + "（未弹出保存框可用「复制 JSON」）");
    } catch (e) {
      alert("下载失败，请用「复制 JSON」：\n" + String((e && e.message) || e));
    }
  }

  if ($("btnWfImport")) {
    $("btnWfImport").onclick = () => {
      const fi = $("wfFileInput");
      fi.value = "";
      fi.onchange = async () => {
        const f = fi.files && fi.files[0];
        if (!f) return;
        try {
          await wfImportPayload({ filePath: f.path || f.name, title: "" });
        } catch (e) {
          alert("读取文件失败：" + String((e && e.message) || e));
        }
      };
      fi.click();
    };
  }
  if ($("btnWfPaste")) {
    $("btnWfPaste").onclick = () => {
      $("wfPasteText").value = "";
      $("wfPasteTitle").value = "";
      openModal(wfModal);
      $("wfPasteText").focus();
    };
    $("btnWfPasteCancel").onclick = () => closeModal(wfModal);
    $("btnWfPasteOk").onclick = async () => {
      const text = String($("wfPasteText").value || "").trim();
      if (!text) {
        alert("请先粘贴 JSON 内容");
        return;
      }
      closeModal(wfModal);
      await wfImportPayload({ text, title: String($("wfPasteTitle").value || "").trim() });
    };
    $("wfPasteText").addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") $("btnWfPasteOk").click();
    });
  }
  if ($("btnWfTemplate")) {
    $("btnWfTemplate").onclick = async () => {
      const doOne = async (mode) => {
        const label = mode === "r2v" ? "R2V（参考图/视频/音频）" : "FL2VA（首末帧）";
        if (!confirm("把内置 " + label + " 工作流另存为库里的自定义工作流？\n保存后可自由编辑与复制，内置链本身不受影响。")) return false;
        const r = await api.wfTemplateExport(mode);
        if (r && r.ok) {
          logLine("内置模板已入库：" + ((r.summary && r.summary.title) || ""));
          refreshWf();
          return true;
        }
        alert("另存失败：" + ((r && r.error) || "未知错误"));
        return false;
      };
      if (await doOne("fl2va")) await doOne("r2v");
    };
  }

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
  if (api.onSage) api.onSage(() => refresh());
  if (api.onWfEditorView) api.onWfEditorView(applyWfEditorView);

  (async () => {
    /* 上次的面板状态先恢复（窗口宽度跟着宿主一起补回来），再灌历史日志 */
    if (paneStored()) await setPaneOpen(true);
    /* 编辑器视图状态自恢复：宿主在 did-finish-load 也会推一次，这里主动拉一次兜住时序 */
    if (api.wfEditorGetView) {
      try {
        const v = await api.wfEditorGetView();
        if (v && v.ok) applyWfEditorView(v.view);
      } catch {}
    }
    const tail = await api.consoleTail(48 * 1024);
    if (tail && tail.text) consoleEl.textContent = tail.text;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    await refresh();
    refreshWf();
    setInterval(refresh, 4000);
  })();
})();

