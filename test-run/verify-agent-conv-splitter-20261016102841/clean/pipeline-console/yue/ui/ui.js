(() => {
  const api = window.yueApi;
  if (!api) {
    document.body.textContent = "yueApi missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
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

    /* 注意力档位：显示**实际生效**的档位与来源（本版默认 cudnn，不自动降级；
       不再写「这一档大概会失败」那种猜测文案 —— 看到什么就是什么） */
    const att = String(st.attentionBackend || "");
    if (attBadge) {
      const src = String(st.attentionSource || "");
      const srcTxt =
        src === "env"
          ? "YUE2_ATTENTION_BACKEND 指定"
          : src === "file"
            ? ".attention-backend 指定"
            : src === "default"
              ? "默认"
              : src || "";
      attBadge.textContent = att ? "注意力 " + att + (srcTxt ? "（" + srcTxt + "）" : "") : "注意力 —";
      attBadge.className = "badge " + (att ? "on" : "off");
      attBadge.title =
        "注意力档位：本版默认 cudnn（Windows 轮子里没编 flash kernel，永不自动选 flash）；" +
        "不自动降级 —— 要换档请设 YUE2_ATTENTION_BACKEND，或在安装目录 .attention-backend 里写单行 sdpa / flash";
    }

    /* 起停门槛仍看安装目录（没装就没后端可起），但安装目录本身不再在这只窗里显示 */
    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;

    if (st.gpu) applyGpu(st.gpu);
    renderConsole(st.consoleTail);
    return st;
  }

  /** 失败出口文案：报错码 missing_dep:<name> / attention_backend_unsupported → 指明修复路径。 */
  function fmtErr(code, msg) {
    const m = String(code || "").match(/^missing_dep:(.+)$/);
    if (m) return `缺依赖 ${m[1]}（可在插件卡片的安装窗里重装后端，或手动 pip install）`;
    if (String(code || "") === "attention_backend_unsupported") {
      return (
        String(msg || "") ||
        "注意力档位在本机跑不起来：本版默认 cudnn 且不自动降级 —— 请设 YUE2_ATTENTION_BACKEND=sdpa，" +
          "或在安装目录 .attention-backend 里写单行 sdpa 后重试"
      );
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

  /* ───── 清空日志：真删文件内容（不只是清显示）─────
   * 旧实现只把 DOM 清空，关窗再开宿主一 consoleTail 旧日志又回来了。
   * 现在先让宿主 truncate 日志文件（宿主保留文件句柄，后端往同一个 inode 续写），
   * 再清 DOM 并复位本地游标；宿主广播 yue:consoleCleared 时（别的窗口点的）做同样的事。 */
  function clearLogView() {
    consoleEl.textContent = "";
    lastConsole = "";
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

  /* 进度事件订阅：安装 / 更新 / Agent 兜底那几档的界面已不在本窗（统一走独立安装窗），
     回调里不再碰任何安装元素；只剩生成档写一行日志，免得生成期间界面一片死寂。 */
  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "generate") logLine("生成: " + (ev.message || ""));
  });
  api.onGpu(applyGpu);

  (async () => {
    await refresh();
    setInterval(refresh, 2500);
  })();
})();
