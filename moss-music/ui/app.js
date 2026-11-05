(() => {
  "use strict";
  const api = window.mossMusicApi;
  const $ = (id) => document.getElementById(id);
  if (!api) {
    document.body.textContent = "mossMusicApi missing：预加载桥没有注入，控制台无法工作。";
    return;
  }

  const el = {
    svcBadge: $("svcBadge"),
    loadBadge: $("loadBadge"),
    verText: $("verText"),
    dirText: $("dirText"),
    notice: $("notice"),
    installDirText: $("installDirText"),
    btnPickDir: $("btnPickDir"),
    btnInstall: $("btnInstall"),
    btnCancelInstall: $("btnCancelInstall"),
    installHint: $("installHint"),
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    svcText: $("svcText"),
    switchHint: $("switchHint"),
    gpuName: $("gpuName"),
    gpuMemTxt: $("gpuMemTxt"),
    gpuMemBar: $("gpuMemBar").querySelector("i"),
    gpuUtilTxt: $("gpuUtilTxt"),
    gpuUtilBar: $("gpuUtilBar").querySelector("i"),
    vramNote: $("vramNote"),
    audioPath: $("audioPath"),
    btnPickAudio: $("btnPickAudio"),
    audioFile: $("audioFile"),
    btnPlay: $("btnPlay"),
    audioHint: $("audioHint"),
    player: $("player"),
    drop: $("drop"),
    question: $("question"),
    btnGenerate: $("btnGenerate"),
    genHint: $("genHint"),
    genStatus: $("genStatus"),
    result: $("result"),
    resultMeta: $("resultMeta"),
    answer: $("answer"),
    cuesWrap: $("cuesWrap"),
    cuesNote: $("cuesNote"),
    cuesBody: $("cuesBody"),
    files: $("files"),
    console: $("console"),
    btnLogClear: $("btnLogClear"),
  };

  const state = {
    status: null,
    busy: "",
    lastLogLen: -1,
    installBusy: false,
    genTimer: null,
    genStartedAt: 0,
  };

  function setBar(node, pct) {
    node.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function fmtGb(gb) {
    const n = Number(gb);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) + "GB" : "—";
  }
  function mmss(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    return String(m).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }
  function showNotice(text, kind) {
    if (!text) {
      el.notice.className = "notice hidden";
      el.notice.textContent = "";
      return;
    }
    el.notice.className = "notice" + (kind ? " " + kind : "");
    el.notice.textContent = text;
  }
  function logLine(s) {
    const text = String(s == null ? "" : s);
    if (!text) return;
    const atBottom = el.console.scrollHeight - el.console.scrollTop - el.console.clientHeight < 40;
    el.console.textContent += text.endsWith("\n") ? text : text + "\n";
    if (atBottom) el.console.scrollTop = el.console.scrollHeight;
  }
  function setBusy(which) {
    state.busy = which || "";
    renderButtons();
  }
  function renderButtons() {
    const st = state.status;
    const notInstalled = !st || !st.installed;
    const running = !!(st && st.running);
    const installing = !!(st && st.installing) || state.installBusy;
    const busy = !!state.busy;
    el.btnInstall.disabled = busy || installing;
    el.btnCancelInstall.classList.toggle("hidden", !installing);
    el.btnPickDir.disabled = busy || installing;
    el.btnStart.disabled = busy || installing || notInstalled || running;
    el.btnStop.disabled = busy || installing || !running;
    el.btnGenerate.disabled = busy || installing || notInstalled;
    el.btnPlay.disabled = busy;
    el.btnPickAudio.disabled = busy;
  }

  function applyGpu(gpu) {
    if (!gpu) return;
    el.gpuName.textContent = "显卡：" + (gpu.name || "NVIDIA GPU");
    el.gpuMemTxt.textContent = `${gpu.memUsed}/${gpu.memTotal} MiB (${gpu.memPct || 0}%)`;
    el.gpuUtilTxt.textContent = (gpu.util == null ? "—" : gpu.util + "%");
    setBar(el.gpuMemBar, gpu.memPct);
    setBar(el.gpuUtilBar, gpu.util);
  }

  function renderStatus(st) {
    state.status = st;
    const running = !!st.running;
    const ready = !!st.ready;
    const installing = !!st.installing || state.installBusy;
    el.verText.textContent = "v" + (st.version || "1.0.0");

    el.svcBadge.textContent = ready ? "服务就绪" : running ? "服务运行中" : "服务关闭";
    el.svcBadge.className = "badge " + (ready ? "on" : running ? "warn" : "off");
    el.loadBadge.textContent = ready
      ? `${st.quant}`
      : st.loading
        ? "装载中…"
        : "未装载模型";
    el.loadBadge.className = "badge " + (ready ? "on" : st.loading ? "warn" : "off");

    el.dirText.textContent = "安装目录：" + (st.installDir || "未选择");
    el.installDirText.textContent = st.installDir || "未选择安装目录";
    el.btnInstall.textContent = st.installed ? "重新安装 / 修复" : "开始安装";
    el.installHint.textContent = installing
      ? "安装进行中：步骤与日志见安装窗与本页日志尾部。"
      : st.installed
        ? "已安装；重跑安装会复用已下载的 uv / 源码 / 权重分片。"
        : "磁盘建议 ≥60GB；8B 权重约 18GB。";
    el.btnCancelInstall.classList.toggle("hidden", !installing);

    el.svcText.textContent = ready
      ? `已装载 Instruct · ${st.quant} · 端口 ${st.port}`
      : running
        ? `服务在 :${st.port}，模型未装载（首次生成会自动装载）`
        : st.installed
          ? "服务未启动"
          : "尚未安装";
    el.btnStart.textContent = running ? "重新装载" : "启动并装载";
    el.btnStart.disabled = !!state.busy || installing || !st.installed || (running && ready);

    for (const b of document.querySelectorAll("button[data-quant]")) {
      b.classList.toggle("active", b.dataset.quant === (st.configuredQuant || "int8"));
      b.disabled = !!state.busy || installing || !st.installed;
    }
    el.switchHint.textContent = ready
      ? `当前 ${st.quant}；切量化档 = 卸载旧权重 + 重新装载 18GB 权重（30~60s）。`
      : "切量化档 = 卸载旧权重 + 重新装载 18GB 权重，约 30~60s。";

    if (st.gpu) applyGpu(st.gpu);
    else {
      el.gpuName.textContent = "显卡：未读到 nvidia-smi 读数";
      el.gpuMemTxt.textContent = "—";
      el.gpuUtilTxt.textContent = "—";
      setBar(el.gpuMemBar, 0);
      setBar(el.gpuUtilBar, 0);
    }
    const v = st.vram || {};
    el.vramNote.textContent = v.notice
      ? v.notice
      : `当前 ${v.quant || st.configuredQuant} 档建议 ≥${fmtGb(v.needGb || v.minGb || 12)} 显存（读不到读数时不做硬拦）。`;
    el.vramNote.className = v.notice ? "warn" : "faint";

    if (!st.installed && st.installDir) {
      const p = st.project || {};
      const missing = [];
      if (!p.server) missing.push("app/server.py");
      if (!p.venv) missing.push(".venv");
      if (!p.source) missing.push("源码");
      if (!p.models) missing.push("模型权重");
      if (!p.marked) missing.push(".install-ok");
      el.installHint.textContent = "安装不完整，缺少：" + missing.join(" / ") + "；重跑安装会补齐。";
    }
    if (st.lock && st.lock.nodeId && !state.busy) {
      el.genHint.textContent = `全局锁被占用（${st.lock.kind || "任务"} ${st.lock.nodeId}），音乐 / 视频任务需排队。`;
    } else if (!state.busy) {
      el.genHint.textContent = "生成本地完成；结果落 md / json / srt 三份文件。";
    }
    renderButtons();
  }

  async function refresh() {
    try {
      const st = await api.getStatus();
      if (st && st.ok) renderStatus(st);
      return st;
    } catch (e) {
      showNotice("读取状态失败：" + String((e && e.message) || e), "err");
    }
  }

  async function refreshLog(force) {
    try {
      const t = await api.consoleTail(96 * 1024);
      if (!t || !t.ok) return;
      const text = t.text || "";
      if (!force && text.length === state.lastLogLen) return;
      state.lastLogLen = text.length;
      const atBottom = el.console.scrollHeight - el.console.scrollTop - el.console.clientHeight < 48;
      el.console.textContent = text;
      if (atBottom) el.console.scrollTop = el.console.scrollHeight;
    } catch {}
  }

  function audioUrl(p) {
    const win = String(p || "").trim().replace(/\\/g, "/");
    if (!win) return "";
    return encodeURI("file:///" + win);
  }
  function setAudio(path) {
    const p = String(path || "").trim();
    if (!p) return;
    el.audioPath.value = p;
    el.player.src = audioUrl(p);
    el.audioHint.textContent = "已选定音频；点「试听」播放，生成用同一份。";
  }
  function showResult(r) {
    el.result.classList.remove("hidden");
    el.answer.textContent = r.text || "（模型没有返回文本）";
    const cues = Array.isArray(r.cues) ? r.cues : [];
    el.cuesWrap.classList.toggle("hidden", !cues.length);
    el.cuesBody.textContent = "";
    for (const c of cues) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.className = "time";
      td1.textContent = mmss(c.start) + "–" + mmss(c.end);
      const td2 = document.createElement("td");
      td2.textContent = c.text || "";
      tr.appendChild(td1);
      tr.appendChild(td2);
      el.cuesBody.appendChild(tr);
    }
    el.cuesNote.textContent = r.estimatedTimestamps
      ? "模型未给出时间戳，按字数估算（非逐句对齐）"
      : `${cues.length} 条时间戳`;
    el.files.textContent = "";
    const f = r.files || {};
    for (const k of ["md", "json", "srt"]) {
      if (!f[k]) continue;
      const div = document.createElement("div");
      div.textContent = k.toUpperCase() + "：";
      const code = document.createElement("code");
      code.textContent = f[k];
      div.appendChild(code);
      el.files.appendChild(div);
    }
    const dur = r.durationSeconds ? `${Math.round(r.durationSeconds)}s` : "?";
    el.resultMeta.textContent = `${r.model}/${r.quant} · ${dur} · ${r.longAudio ? "长音频切片" : "整曲"} · ${r.elapsedSeconds || "?"}s` +
      (r.autoSplit ? " · 撞上限已自动对半切补齐" : "") +
      (r.truncated ? " · ⚠ 输出可能不完整（已达上限）" : "");
  }

  function setGenStatus(text) {
    if (!text) {
      el.genStatus.classList.add("hidden");
      el.genStatus.textContent = "";
      return;
    }
    el.genStatus.classList.remove("hidden");
    el.genStatus.textContent = text;
  }

  /* ------------------------------ 事件 ------------------------------ */

  el.btnPickDir.onclick = async () => {
    const r = await api.pickInstallDir().catch((e) => ({ ok: false, error: String(e) }));
    if (r && r.ok) {
      showNotice("", "");
      logLine("[ui] 安装目录 = " + r.installDir);
    } else if (r && !r.cancelled) {
      showNotice("目录不可用：" + (r.error || "bad_dir"), "err");
    }
    refresh();
  };

  el.btnInstall.onclick = async () => {
    if (!state.status || !state.status.installDir) {
      showNotice("先选择安装目录。", "err");
      return;
    }
    state.installBusy = true;
    renderButtons();
    setBusy("install");
    showNotice("安装已开始：步骤行在安装窗，详细输出在本页日志尾部。", "info");
    try {
      const r = await api.install({});
      if (r && r.ok) {
        showNotice("安装完成。", "info");
      } else {
        const code = (r && r.error) || "install_failed";
        showNotice(
          "安装未完成：" +
            code +
            (code === "low_disk" && r.freeGb != null ? `（剩余 ${r.freeGb}GB / 需要 ≥${r.needGb}GB）` : "") +
            "；看日志尾部或安装窗的失败步。",
          "err",
        );
      }
    } catch (e) {
      showNotice("安装失败：" + String((e && e.message) || e), "err");
    } finally {
      state.installBusy = false;
      setBusy("");
      refresh();
      refreshLog(true);
    }
  };

  el.btnCancelInstall.onclick = async () => {
    showNotice("正在取消安装（会强杀安装进程树，已下载文件保留）…", "info");
    try {
      await api.cancelInstall();
    } catch (e) {
      showNotice("取消失败：" + String((e && e.message) || e), "err");
    }
    refresh();
  };

  el.btnStart.onclick = async () => {
    setBusy("start");
    setGenStatus("启动后端并装载模型…首次装载 18GB 权重可能需要 30~90s。");
    showNotice("", "");
    try {
      const r = await api.start();
      if (r && r.ok) {
        showNotice(`服务已就绪（Instruct · ${r.quant || state.status.configuredQuant}）。`, "info");
      } else {
        showNotice("启动失败：" + ((r && (r.message || r.error)) || "unknown"), "err");
      }
    } catch (e) {
      showNotice("启动失败：" + String((e && e.message) || e), "err");
    } finally {
      setBusy("");
      setGenStatus("");
      refresh();
      refreshLog(true);
    }
  };

  el.btnStop.onclick = async () => {
    setBusy("stop");
    try {
      const r = await api.stop();
      showNotice(r && r.ok ? "服务已停止，显存已释放。" : "停止失败：" + ((r && r.error) || ""), r && r.ok ? "info" : "err");
    } catch (e) {
      showNotice("停止失败：" + String((e && e.message) || e), "err");
    } finally {
      setBusy("");
      refresh();
    }
  };

  for (const b of document.querySelectorAll("button[data-quant]")) {
    b.onclick = async () => {
      const quant = b.dataset.quant;
      setBusy("quant");
      setGenStatus(`正在切换量化档到 ${quant}（若服务已装载会重载权重）…`);
      try {
        const r = await api.setQuant({ quant });
        if (r && r.ok) {
          showNotice(r.reloaded ? `量化档已切到 ${quant}，模型已重载。` : `量化档已记为 ${quant}，下次装载生效。`, "info");
        } else {
          showNotice("切换量化档失败：" + ((r && (r.message || r.error)) || "unknown"), "err");
        }
      } catch (e) {
        showNotice("切换量化档失败：" + String((e && e.message) || e), "err");
      } finally {
        setBusy("");
        setGenStatus("");
        refresh();
      }
    };
  }

  el.btnPickAudio.onclick = () => el.audioFile.click();
  el.audioFile.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const p = f.path || "";
    if (p) setAudio(p);
    else {
      el.player.src = URL.createObjectURL(f);
      el.audioHint.textContent = "已载入音频可试听；这个 Electron 版本不暴露本地路径，请把绝对路径粘贴到输入框再生成。";
    }
  };
  el.audioPath.onchange = () => setAudio(el.audioPath.value);
  el.audioPath.onkeydown = (e) => {
    if (e.key === "Enter") setAudio(el.audioPath.value);
  };
  el.btnPlay.onclick = async () => {
    const p = String(el.audioPath.value || "").trim();
    if (p) setAudio(p);
    if (!el.player.src) {
      showNotice("先选择音频或粘贴绝对路径。", "err");
      return;
    }
    try {
      await el.player.play();
    } catch (e) {
      showNotice("试听失败：" + String((e && e.message) || e), "err");
    }
  };

  for (const b of document.querySelectorAll("button[data-prompt]")) {
    b.onclick = () => {
      el.question.value = b.dataset.prompt;
      el.question.focus();
    };
  }

  /* 拖放音频：能拿到 path 就用 path，拿不到就只做试听 */
  el.drop.ondragover = (e) => {
    e.preventDefault();
    el.drop.classList.add("hover");
  };
  el.drop.ondragleave = () => el.drop.classList.remove("hover");
  el.drop.ondrop = (e) => {
    e.preventDefault();
    el.drop.classList.remove("hover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (f.path) setAudio(f.path);
    else {
      el.player.src = URL.createObjectURL(f);
      el.audioHint.textContent = "已载入音频可试听；请把绝对路径粘贴到输入框再生成。";
    }
  };

  el.btnGenerate.onclick = async () => {
    const audioPath = String(el.audioPath.value || "").trim();
    if (!audioPath) {
      showNotice("先选择音频或粘贴音频绝对路径。", "err");
      return;
    }
    const question = String(el.question.value || "").trim();
    setBusy("generate");
    state.genStartedAt = Date.now();
    setGenStatus("生成中…（长音频按 3 分钟切片，整曲可能数分钟）");
    if (state.genTimer) clearInterval(state.genTimer);
    state.genTimer = setInterval(() => {
      const sec = Math.round((Date.now() - state.genStartedAt) / 1000);
      setGenStatus(`生成中…已 ${mmss(sec)}（长音频按 3 分钟切片顺序推理）`);
    }, 1000);
    showNotice("", "");
    try {
      const r = await api.generate({ audioPath, question, longAudio: true });
      if (r && r.ok) {
        showResult(r);
        const warn = Array.isArray(r.warnings) && r.warnings.length ? " " + r.warnings.join(" ") : "";
        showNotice(
          "完成。" + (r.estimatedTimestamps ? "模型没给时间戳，cues 为按字数估算。" : "") + warn,
          "info",
        );
      } else {
        showNotice("生成失败：" + ((r && (r.message || r.error)) || "unknown"), "err");
      }
    } catch (e) {
      showNotice("生成失败：" + String((e && e.message) || e), "err");
    } finally {
      if (state.genTimer) clearInterval(state.genTimer);
      state.genTimer = null;
      setBusy("");
      setGenStatus("");
      refresh();
      refreshLog(true);
    }
  };

  el.btnLogClear.onclick = () => {
    el.console.textContent = "";
    state.lastLogLen = -1;
  };

  /* ------------------------------ 启动 ------------------------------ */

  api.onConsole((d) => {
    if (d && d.line) logLine(d.line);
  });
  api.onGpu((gpu) => applyGpu(gpu));

  (async () => {
    await refresh();
    const st = state.status;
    if (st && st.installDir && st.installed) {
      el.audioPath.focus();
    } else if (st && !st.installDir) {
      showNotice("先选择安装目录并完成安装，然后启动服务。", "info");
    }
    await refreshLog(true);
    setInterval(refresh, 5000);
    setInterval(() => refreshLog(false), 1500);
  })();
})();
