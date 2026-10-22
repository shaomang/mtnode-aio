(() => {
  const api = window.h3Api;
  if (!api) {
    document.body.textContent = "h3Api missing";
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
    const running = !!st.running || !!st.comfyUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");
    /* 标题行：把 ComfyUI 地址常驻亮出来（一键打开时用户知道会开到哪儿）。
       地址跟着标题行走（#comfyHint 在 h1 里），不再放在按钮条 —— 窄窗不会被两个按钮挤掉。 */
    const port = Number(st.port) || 8188;
    const url = st.comfyUrl || "http://127.0.0.1:" + port + "/";
    const hint = $("comfyHint");
    if (hint) {
      if (st.comfyStarting) {
        hint.textContent = "◐ ComfyUI 启动中… :" + port;
        hint.title = "后端正在后台启动，就绪后自动打开浏览器（首次加载模型可能要几分钟，期间可继续用其它功能）";
      } else {
        hint.textContent = (running ? "● " : "○ ") + "ComfyUI :" + port;
        hint.title =
          url +
          "（后端只监听本机，浏览器同机打开）" +
          (st.comfyStartError ? " · 上次启动失败：" + st.comfyStartError : "");
      }
    }
    if (comfyBtn) {
      comfyBtn.title = st.comfyStarting
        ? "后端正在启动，就绪后会自动打开浏览器 " + url
        : running
          ? "在浏览器打开 " + url
          : "后端未运行 · 点了会先问你是否启动 " + url;
      comfyBtn.classList.toggle("on", running);
    }

    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;
    $("btnUninstall").disabled = !st.installDir || !!st.installing;

    if (st.gpu) applyGpu(st.gpu);
    renderSage(st);
    syncLaunchOptsUi(st);
    return st;
  }

  /* ── Sage Attention（注意力加速）状态 ─────────────────────────────
   * 口径：Sage 是 H3 的**必须项** —— 安装流程会把它一起装上；未就绪时宿主拒绝启动后端、
   * 也拒绝出片。所以这里不再是「可选加速」的灰字，而是：
   *   ① 顶部常驻红条（豁免时降级为黄条）+ 「立即补装 Sage」按钮；
   *   ② 状态行写清缺什么、点哪儿补；
   *   ③ 「Sage 加速」按钮高亮（未就绪时闪红）。
   * 主进程在 venv 里真探一次（triton 与 sageattention 必须成对：sageattention 的 core
   * 在 import 期就拉 Triton kernel），结果带缓存。 */
  function renderSage(st) {
    const info = st.sage || {};
    const exempt = st.sageExempt || {};
    const hasVenv = !!(st.project && st.project.venv);
    const ready = !!info.ok;
    const waived = !ready && !!exempt.active;
    const btn = $("btnSage");
    if (btn) {
      btn.disabled = !hasVenv || !!st.installing;
      btn.classList.toggle("on", ready);
      btn.classList.toggle("danger", !ready && !waived);
      btn.title = ready
        ? "已就绪：sageattention " + info.sage + " + triton " + info.triton + "（再点一次只复核，不重装）"
        : waived
          ? "已豁免（" + (exempt.reason || "显式豁免") + "）：点一下会尝试补装并复检"
          : "Sage 加速是必须项（triton-windows + 与本 venv 配套的 sageattention 预编译 wheel）：未就绪则后端不启动、也不出片。点一下自检并补装";
    }
    /* 横幅：未就绪就常驻（红 = 未豁免会拦住出片与启动；黄 = 用户已显式豁免，仍告警） */
    const ban = $("sageBanner");
    if (ban) {
      ban.hidden = ready || !hasVenv;
      ban.classList.toggle("exempt", waived);
      const t = $("sageBannerTitle");
      const x = $("sageBannerText");
      if (t)
        t.textContent = waived
          ? "Sage 加速已豁免：本机按无 Sage 出片（慢约 1.5-2×）"
          : "Sage 加速未就绪（必须项）：后端不会启动，也不会出片";
      if (x)
        x.textContent = waived
          ? "豁免来源：" + (exempt.reason || "显式声明") + "。想恢复全速就在 venv 里补装（点右侧按钮），装好即恢复强制校验。"
          : (info.why ? "自检事实：" + info.why + "。" : "") +
            "Windows 上要 triton-windows + 与本 venv 配套的 sageattention 预编译 wheel 成对装上；安装窗的「安装」会把 Sage 一起装，这里是就地补装 + 复检。" +
            (st.installing ? "（当前有安装任务在跑）" : "");
      const fix = $("btnSageFix");
      if (fix) fix.disabled = !hasVenv || !!st.installing;
    }
    const el = $("sageInfo");
    if (!el) return;
    if (!hasVenv) el.textContent = "Sage Attention（必须项）：待后端装好后才能自检（先在插件卡片的安装窗里把它装好）";
    else if (!info.probed) el.textContent = "Sage Attention（必须项）：自检中…（在 venv 里 import 一次，几秒）";
    else if (ready)
      el.textContent =
        "Sage Attention ✓ 已就绪：sageattention " + info.sage + " · triton " + info.triton + " · " + (info.sm || "?") + " → 生成前还会真跑一次小 kernel 确认能算";
    else if (waived)
      el.textContent =
        "Sage Attention 未就绪（已豁免：" + (exempt.reason || "显式声明") + "）：启动与出片放行，按无 Sage 跑，慢约 1.5-2×。";
    else
      el.textContent =
        "Sage Attention 未就绪（" + (info.why || "缺包") + "）：必须项，宿主会拒绝启动后端 / 拒绝出片。点「Sage 加速」或上方红条里的「立即补装 Sage」。";
  }

  function syncLaunchOptsUi(st) {
    /* 系统内存缓存的保留下限：关掉 = 0（不加 --cache-ram，退回 ComfyUI 默认）。
     * 这是「超分把 64G 内存跑满、显存空着」那一档的正解开关，默认开 8G。 */
    const cacheGb = Math.max(0, Math.round(Number(st.optCacheRamGb) || 0));
    const map = [
      ["optPinned", st.optDisablePinnedMemory !== false],
      ["optFp16", st.optFp16Intermediates !== false],
      ["optExpand", st.optExpandableSegments !== false],
      ["optCacheRam", cacheGb > 0],
      ["optRebuildRam", st.optRebuildOnRamHigh !== false],
    ];
    for (const [id, on] of map) {
      const el = $(id);
      if (el && !el._bound) {
        el._bound = true;
        el.addEventListener("change", saveLaunchOpts);
      }
      if (el) el.checked = !!on;
    }
    const gbEl = $("optCacheRamGb");
    if (gbEl && !gbEl._bound) {
      gbEl._bound = true;
      gbEl.addEventListener("change", saveLaunchOpts);
    }
    if (gbEl) {
      gbEl.value = String(cacheGb > 0 ? cacheGb : 8);
      gbEl.disabled = !$("optCacheRam").checked;
    }
    const thEl = $("optArenaThreads");
    if (thEl && !thEl._bound) {
      thEl._bound = true;
      thEl.addEventListener("change", saveLaunchOpts);
    }
    if (thEl) {
      const n = Math.max(0, Math.round(Number(st.optArenaThreads) || 0));
      thEl.value = String(n > 0 ? n : 0);
    }
    renderMemRail(st);
  }

  /* 内存护栏现状：后端自己报的空闲 / 总内存 + 最近一次回收时间。
   * 让「跑几单之后内存一路攀升」这件事在管理窗里可读，而不是只留在 console。 */
  function renderMemRail(st) {
    const el = $("memRailInfo");
    if (!el) return;
    const ram = st.memRail || null;
    const bits = [];
    const gb = (v) => (v == null || !isFinite(Number(v)) ? "—" : Math.round(Number(v) * 10) / 10 + "G");
    if (ram && (ram.free != null || ram.total != null)) {
      bits.push("系统内存：可用 " + gb(ram.free) + " / 共 " + gb(ram.total));
    } else {
      bits.push("系统内存：后端未运行或未上报");
    }
    if (st.optRebuildOnRamHigh === false) bits.push("内存护栏已关（进程不再回收）");
    const at = Number(st.lastRecycleAt) || 0;
    if (at > 0) {
      const d = new Date(at);
      const pad = (n) => String(n).padStart(2, "0");
      bits.push(
        "后端最近一次回收：" +
          d.getFullYear() +
          "-" +
          pad(d.getMonth() + 1) +
          "-" +
          pad(d.getDate()) +
          " " +
          pad(d.getHours()) +
          ":" +
          pad(d.getMinutes()),
      );
    }
    el.textContent = bits.join(" · ");
  }

  /** 启动优化回写：一次把这一区的全部取值交给主进程（保存后下次启动后端生效） */
  async function saveLaunchOpts() {
    if (!api.setLaunchOpts) return;
    const on = $("optCacheRam").checked;
    const gb = Math.max(1, Math.min(128, Math.round(Number($("optCacheRamGb").value) || 8)));
    $("optCacheRamGb").disabled = !on;
    const thEl = $("optArenaThreads");
    const threads = Math.max(0, Math.min(64, Math.round(Number(thEl && thEl.value) || 0)));
    if (thEl) thEl.value = String(threads);
    const r = await api.setLaunchOpts({
      optDisablePinnedMemory: !!$("optPinned").checked,
      optFp16Intermediates: !!$("optFp16").checked,
      optExpandableSegments: !!$("optExpand").checked,
      optCacheRamGb: on ? gb : 0,
      optRebuildOnRamHigh: !!$("optRebuildRam").checked,
      optArenaThreads: threads,
    });
    const note = $("launchOptsNote");
    if (note) {
      note.textContent =
        (r && r.note) || "已保存" +
          (on ? "（系统内存缓存保留下限 " + gb + "G）" : "（系统内存缓存用 ComfyUI 默认，无上限）");
    }
    logLine("启动优化已保存（下次启动生效）");
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

  /* 安装目录选择 / 「安装」/ 「自我修复」/ 安装进度都不在这只窗里了：
     安装相关操作与显示统一收进独立安装窗（plugins/main-install.js）；
     宿主侧的 h3:pickInstallDir / h3:install / h3:selfRepair 等 IPC 原样保留。 */

  /* 补装 Sage：红条里的「立即补装 Sage」与工具条上的「Sage 加速」走同一段逻辑，
     装完不是「缺它只影响速度」的旧口径 —— 未就绪时宿主会拒绝启动与出片。 */
  async function installSageNow(fromBanner) {
    if (!api.installSage) {
      logLine("当前版本不支持 Sage 自检 / 补装");
      return;
    }
    logLine("Sage 加速（必须项）：先在 venv 里自检（triton + sageattention 成对），缺则补装…");
    const r = await api.installSage({});
    if (r && r.ok) {
      logLine("[sage] " + ((r && r.message) || "已就绪"));
      if (fromBanner && r.already) logLine("[sage] 复核通过，无需重装");
    } else {
      logLine(
        "[sage] 补装失败: " +
          ((r && (r.message || r.error)) || "未知错误") +
          "（Sage 是必须项：未就绪时后端不启动、也不出片；确属本机不支持请在 config.json 写 sageExempt 或设 MT_H3_SAGE_EXEMPT=1 豁免）",
      );
    }
    refresh();
  }

  $("btnSage").onclick = () => installSageNow(false);
  const sageFix = $("btnSageFix");
  if (sageFix) sageFix.onclick = () => installSageNow(true);

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
    logLine("正在卸载（大目录可能要几分钟）…");
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
   * 再清 DOM 并复位面板未读数；宿主广播 h3:consoleCleared 时（别的窗口点的）做同样的事。 */
  function clearLogView() {
    consoleEl.textContent = "";
    paneUnread = 0;
    renderBadge();
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
  if ($("btnClearLog")) $("btnClearLog").onclick = clearLog;
  if (api.onConsoleCleared) api.onConsoleCleared(() => clearLogView());

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
      /* start 分支现在**立刻**返回 starting=true：后端在后台起，就绪后宿主自己打开浏览器。
         点击不再被后端冷启动（几分钟）挡住 —— 这里只写一行进度，别让按钮看起来没反应。 */
      if (r && r.ok && r.starting) {
        const u = r.url || "";
        logLine("[comfy] 正在后台启动后端，就绪后会自动打开浏览器：" + u);
        logLine("[comfy] 首次启动要加载模型，可能要几分钟；这期间可以继续用其它功能（进度看下面 Console）");
        return;
      }
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
      wfEditorSrcEl.textContent =
        url +
        (view.loading ? " · 正在载入这条模板…" : view.loaded ? " · 已载入这条模板" : "");
      wfEditorSrcEl.title = "编辑发生在 ComfyUI 自己的现场里，不会写回插件库；收回库的唯一入口是「导入 JSON」";
    }
    /* 没自动灌进画布时，宿主的提示（含要在 Workflow › Open 里选的文件名）必须亮着，别让人对着空画布猜；
       注入还在后台跑时先亮一句「正在载入…」（不是失败提示，所以换中性配色，见 .ed-note.loading） */
    const note = view.loading
      ? "正在把这条模板载入编辑器…（ComfyUI 前端还在加载，通常几秒到十几秒）"
      : view.loaded
        ? ""
        : String(view.hint || view.error || "");
    if (wfEditorNoteEl) {
      wfEditorNoteEl.textContent = note;
      wfEditorNoteEl.hidden = !note;
      wfEditorNoteEl.classList.toggle("loading", !!view.loading);
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
          (r.loading
            ? " · 正在把模板载入编辑器…"
            : r.loaded
              ? " · 已自动载入这条模板"
              : " · 需在工作流列表里手动选文件"),
      );
      if (r.hint) logLine("[wf-editor] " + r.hint);
      /* 正常路径宿主会推状态；成功返回这里再兜一次，某条路径漏推时浮层也出得来 */
      applyWfEditorView({
        open: true,
        url: r.url,
        title: r.title,
        file: r.file,
        loading: !!r.loading,
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
      logLine("[wf-editor] 后端首次启动要加载模型，可能要几分钟；就绪后编辑器会自己出现");
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
  if (api.onSage) api.onSage(() => refresh());
  if (api.onWfEditorView) api.onWfEditorView(applyWfEditorView);
  /* 「ComfyUI 编辑界面」后台启动作业的状态推送：启动中 / 已打开 / 失败都写一行，
     并立刻刷新标题行的地址态（4s 轮询之外不必等）。 */
  if (api.onComfyOpen) {
    api.onComfyOpen((s) => {
      if (!s) return;
      if (s.running) logLine("[comfy] 后端启动中…（就绪后自动打开浏览器）");
      else if (s.error) logLine("[comfy] 后端启动失败：" + s.error + "（可再点一次「ComfyUI 编辑界面」重试）");
      else if (s.url) logLine("[comfy] 后端已就绪，已在浏览器打开 " + s.url);
      refresh();
    });
  }

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

