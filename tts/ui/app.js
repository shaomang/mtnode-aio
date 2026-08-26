"use strict";

const api = window.ttsApi;
if (!api) {
  document.body.innerHTML = "<p style='color:#f66;padding:16px'>ttsApi unavailable</p>";
}

let state = {
  apiKey: "",
  apiVisible: false,
  installRunning: false,
  startRunning: false,
  voices: [],
  projects: [],
  activeProject: "",
  uploadBusy: false,
  trainPollTimer: null,
  trainPollName: null,
};

const $ = (id) => document.getElementById(id);

function logLine(s) {
  if (api && api.log) api.log(s);
}

function setBar(el, pct) {
  if (!el) return;
  const bar = el.querySelector ? el.querySelector("i") : null;
  const target = bar || el;
  if (target) target.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
}

function setBtnWaiting(btn, waiting, idleLabel, waitLabel) {
  if (!btn) return;
  btn.disabled = !!waiting;
  btn.classList.toggle("waiting", !!waiting);
  btn.textContent = "";
  if (waiting) {
    const spin = document.createElement("span");
    spin.className = "spin";
    btn.appendChild(spin);
    btn.appendChild(document.createTextNode(waitLabel || "等待中"));
  } else {
    btn.textContent = idleLabel;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 600000);
  const step = intervalMs || 1500;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function syncConsoleBtn(open) {
  const b = $("btnConsole");
  if (!b) return;
  b.classList.toggle("active", !!open);
}

function syncApiPanel() {
  const panel = $("apiPanel");
  const btn = $("btnApi");
  if (panel) panel.classList.toggle("on", state.apiVisible);
  if (btn) btn.classList.toggle("active", state.apiVisible);
}

function setInstallProgress(on, step, pct) {
  const box = $("installProgress");
  if (!box) return;
  if (on) {
    box.classList.add("on");
    const txt = $("installStepTxt");
    if (txt) txt.textContent = step || "安装中…";
    if (pct != null) setBar($("installBar"), pct);
  } else if (!state.installRunning) {
    box.classList.remove("on");
  }
  const installBusy = !!(on || state.installRunning);
  setBtnWaiting($("btnInstall"), installBusy, "安装", "等待中");
  if ($("btnPickDir")) $("btnPickDir").disabled = installBusy;
}

function renderVoices(items) {
  state.voices = Array.isArray(items) ? items : [];
  const list = $("voiceList");
  const sel = $("voiceSelect");
  if (list) {
    list.innerHTML = "";
    if (!state.voices.length) {
      list.innerHTML = '<div class="meta">无音色 — 在 voices/ 目录放置 ref.wav + ref.txt + ref.lang，或调用 /api/voices/add 上传</div>';
    } else {
      for (const v of state.voices) {
        const row = document.createElement("div");
        row.className = "item-row";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = v.id + (v.trained ? " [已训练]" : "") + (v.promptText ? " · " + v.promptText.slice(0, 24) : "");
        name.title = v.refAudio;
        row.appendChild(name);
        list.appendChild(row);
      }
    }
  }
  if (sel) {
    sel.innerHTML = "";
    for (const v of state.voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.id + (v.trained ? " [已训练]" : "") + " (" + (v.lang || "auto") + ")";
      sel.appendChild(opt);
    }
    sel.disabled = !state.voices.length;
  }
}

async function refreshStatus() {
  const st = await api.getStatus();
  $("installDir").textContent = st.installDir || "未选择安装目录";
  const installed = st.installed || (st.project && st.project.ready);
  const installBusy = !!st.installing || state.installRunning;
  if (!installBusy) {
    setBtnWaiting($("btnInstall"), false, "安装", "等待中");
    $("btnInstall").disabled = !st.installDir;
    if ($("btnPickDir")) $("btnPickDir").disabled = false;
  } else {
    setBtnWaiting($("btnInstall"), true, "安装", "等待中");
    if ($("btnPickDir")) $("btnPickDir").disabled = true;
  }
  if (state.startRunning) {
    setBtnWaiting($("btnStart"), true, "启用", "等待中");
    $("btnStop").disabled = true;
  } else {
    setBtnWaiting($("btnStart"), false, "启用", "等待中");
    $("btnStart").disabled = !installed || st.running;
    $("btnStop").disabled = !st.running;
  }
  syncConsoleBtn(st.logPanelOpen);

  const badge = $("svcBadge");
  if (st.running && st.apiUp) {
    badge.textContent = "运行中";
    badge.className = "badge on";
  } else if (st.running) {
    badge.textContent = "启动中";
    badge.className = "badge";
  } else {
    badge.textContent = "未运行";
    badge.className = "badge off";
  }

  if (st.apiStatus) {
    $("apiBase").textContent = st.apiStatus.apiBase || "—";
    $("apiKey").textContent = st.apiStatus.apiKey || "—";
    state.apiKey = st.apiStatus.apiKey || "";
    renderVoices(st.apiStatus.voices);
  }

  if (!(st.installing || state.installRunning)) {
    setInstallProgress(false);
  }
  return st;
}

async function apiCall(path, method, body, needKey) {
  const r = await api.apiFetch({
    path,
    method: method || "GET",
    body,
    apiKey: needKey === false ? "" : state.apiKey,
  });
  if (!r.ok) throw new Error((r.json && r.json.detail) || r.error || "request_failed");
  return r.json;
}

// ---- audio training ----

function setUploadStatus(text, ok) {
  const el = $("uploadStatus");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok === true ? "var(--ok)" : ok === false ? "var(--danger)" : "var(--muted)";
  el.style.display = text ? "block" : "none";
}

function fmtDur(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (m ? m + "分" : "") + s + "秒";
}

function renderProjectDetail(p) {
  const wrap = $("projectDetail");
  const filesEl = $("projectFiles");
  const trTitle = $("transcriptTitle");
  const trEl = $("projectTranscript");
  const audio = $("projectAudio");
  if (!wrap) return;
  if (!p || !state.activeProject) {
    wrap.style.display = "none";
    return;
  }
  const files = (p.files || []).filter((f) => f.kind === "audio");
  const text = p.transcript || "";
  filesEl.innerHTML = "";
  if (!files.length) {
    filesEl.innerHTML = '<div class="meta">暂无音频 — 点击「上传音频」添加</div>';
  } else {
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "item-row";
      const nm = document.createElement("div");
      nm.className = "name";
      nm.textContent = f.name + (f.dur ? " · " + fmtDur(f.dur) : "");
      nm.title = f.name;
      const btn = document.createElement("button");
      btn.className = "mini pv";
      btn.textContent = "▶ 预览";
      btn.dataset.file = f.name;
      row.appendChild(nm);
      row.appendChild(btn);
      filesEl.appendChild(row);
    }
  }
  trTitle.style.display = text ? "block" : "none";
  trEl.style.display = text ? "block" : "none";
  trEl.textContent = text;
  if (audio) audio.style.display = "none";
  wrap.style.display = "flex";
}

async function loadProjectDetail(name) {
  if (!name) {
    renderProjectDetail(null);
    return;
  }
  try {
    const r = await api.projectFiles(name);
    const p = r && r.ok && r.json && r.json.project;
    if (p) renderProjectDetail(p);
  } catch (e) {
    renderProjectDetail(null);
  }
}

function showTrainBox() {
  const box = $("trainProgress");
  if (box) box.style.display = "flex";
}
function hideTrainBox() {
  if (state.trainPollName) return;
  const box = $("trainProgress");
  if (box) box.style.display = "none";
}

function renderTrainSteps(p) {
  const wrap = $("trainSteps");
  if (!wrap) return;
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const idx = Number(p.stepIndex);
  if (!steps.length) {
    wrap.innerHTML = "";
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  wrap.innerHTML = "";
  steps.forEach((s, i) => {
    const chip = document.createElement("span");
    chip.className = "step-chip " + (i < idx ? "done" : i === idx ? "cur" : "");
    chip.textContent = (i < idx ? "✓ " : i === idx ? "▶ " : "") + (s.label || s.phase || "");
    wrap.appendChild(chip);
  });
}

function renderTrainProgress(p) {
  if (!p) return;
  const phase = $("trainPhase");
  if (phase) {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const idx = Number(p.stepIndex);
    const pos = idx >= 0 && steps.length ? "第 " + (idx + 1) + "/" + steps.length + " 步 · " : "";
    phase.textContent = pos + (p.phaseLabel || p.phase || "训练中") + " · " + Math.round(p.pct || 0) + "%";
  }
  renderTrainSteps(p);
  const det = $("trainDetail");
  if (det) {
    const d = (p.detail || "").trim();
    det.textContent = d || "";
    det.style.display = d ? "block" : "none";
  }
  setBar($("trainBar"), p.pct);
  const logEl = $("trainLog");
  if (logEl && p.logTail != null) {
    if (logEl.textContent !== p.logTail) {
      logEl.textContent = p.logTail;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

function selectProject(name) {
  state.activeProject = name || "";
  const p = state.projects.find((x) => (x.slug || x.name) === name);
  const meta = $("projectMeta");
  if (!p) {
    meta.textContent = "未选择项目";
  } else {
    const dur = Math.round(p.durationSec || 0);
    meta.textContent =
      (p.name || p.slug) +
      " · " +
      p.audioCount +
      " 段音频 · " +
      dur +
      "s" +
      (p.hasTranscript ? " · 有文字" : " · 无文字(将自动ASR)") +
      " · 状态: " +
      p.status;
  }
  const busy = !!(p && (p.status === "training" || p.running));
  $("btnUploadAudio").disabled = !p || busy || state.uploadBusy;
  $("btnUploadText").disabled = !p || busy || state.uploadBusy;
  $("btnUploadPaths").disabled = !p || busy || state.uploadBusy;
  $("btnTrain").disabled = !p || busy || p.status === "trained" || (p.audioCount || 0) < 1;
  $("btnCancelTrain").disabled = !busy;
  if (busy) {
    showTrainBox();
    renderTrainProgress(p);
  } else {
    hideTrainBox();
  }
  loadProjectDetail(name);
}

async function loadProjects() {
  try {
    const r = await api.projectList();
    const items = (r && r.ok && r.json && r.json.items) || [];
    state.projects = items;
    const sel = $("projectSelect");
    const prev = sel.value || state.activeProject;
    sel.innerHTML = "";
    for (const p of items) {
      const opt = document.createElement("option");
      opt.value = p.slug || p.name;
      const st = p.status === "trained" ? "✓" : p.status === "training" ? "⏳" : p.status === "failed" ? "✗" : "";
      opt.textContent = (p.name || p.slug) + (st ? " [" + st + "]" : "");
      sel.appendChild(opt);
    }
    sel.disabled = !items.length;
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    else if (items.length) sel.value = items[0].slug || items[0].name;
    selectProject(sel.value || "");
  } catch (e) {
    logLine("项目列表加载失败: " + ((e && e.message) || e));
  }
}

function stopTrainPoll() {
  if (state.trainPollTimer) {
    clearInterval(state.trainPollTimer);
    state.trainPollTimer = null;
  }
  state.trainPollName = null;
}

function startTrainPoll(name) {
  stopTrainPoll();
  state.trainPollName = name;
  showTrainBox();
  state.trainPollTimer = setInterval(async () => {
    try {
      const r = await api.projectStatus(state.trainPollName);
      const p = r && r.ok && r.json && r.json.project;
      if (!p) return;
      renderTrainProgress(p);
      if (p.status !== "training" && !p.running) {
        stopTrainPoll();
        logLine(
          p.status === "trained"
            ? "训练完成，音色已注册: " + (p.name || state.trainPollName)
            : "训练结束: " + (p.error || p.status),
        );
        setBtnWaiting($("btnTrain"), false, "开始训练", "训练中");
        $("btnCancelTrain").disabled = true;
        await refreshStatus();
        await loadProjects();
      }
    } catch (e) {
      stopTrainPoll();
    }
  }, 2500);
}

$("btnApi").onclick = () => {
  state.apiVisible = !state.apiVisible;
  syncApiPanel();
};

$("btnConsole").onclick = async () => {
  if (!api.toggleLogPanel) return;
  const r = await api.toggleLogPanel();
  syncConsoleBtn(r && r.open);
};

$("btnPickDir").onclick = async () => {
  const r = await api.pickInstallDir();
  if (r.ok) refreshStatus();
};

function runInstallAsync() {
  if (state.installRunning) return;
  state.installRunning = true;
  setInstallProgress(true, "开始安装（国内镜像）…", 5);
  logLine("开始安装（国内镜像 pip）…");
  api
    .install({})
    .then((r) => {
      if (r && r.ok) {
        logLine(r.installedByAgent ? "Agent 保底安装完成" : "脚本安装完成");
        setInstallProgress(true, "安装完成", 100);
      } else {
        logLine("安装失败: " + ((r && r.error) || "?"));
        setInstallProgress(true, "安装失败", 0);
      }
    })
    .catch((e) => {
      logLine("安装异常: " + ((e && e.message) || e));
      setInstallProgress(true, "安装异常", 0);
    })
    .finally(() => {
      state.installRunning = false;
      setTimeout(() => {
        setInstallProgress(false);
        refreshStatus();
      }, 1200);
    });
}

$("btnInstall").onclick = () => runInstallAsync();

$("btnStart").onclick = async () => {
  if (state.startRunning) return;
  state.startRunning = true;
  setBtnWaiting($("btnStart"), true, "启用", "等待中");
  $("btnStop").disabled = true;
  logLine("启动服务…");
  try {
    const r = await api.start();
    if (r && r.ok) {
      const ready = await waitUntil(async () => {
        const st = await api.getStatus();
        return st && st.apiUp ? st : null;
      }, 180000, 1500);
      if (ready) {
        logLine("服务已启动");
        await refreshStatus();
      } else {
        logLine("服务启动超时，可查看 Console");
      }
    } else {
      logLine("启动失败: " + ((r && r.error) || "?"));
    }
  } catch (e) {
    logLine("启动异常: " + ((e && e.message) || e));
  } finally {
    state.startRunning = false;
  }
  refreshStatus();
};

$("btnStop").onclick = async () => {
  logLine("停止服务…");
  await api.stop();
  refreshStatus();
};

$("btnSynth").onclick = async () => {
  const text = ($("ttsText").value || "").trim();
  const voice = $("voiceSelect").value || "";
  if (!text) return logLine("请输入文本");
  logLine("合成中… voice=" + (voice || "default"));
  setBtnWaiting($("btnSynth"), true, "合成", "合成中");
  try {
    const r = await api.apiFetch({
      path: "/api/tts",
      method: "POST",
      body: { text, voice, speed: 1.0, media_type: "wav" },
      apiKey: state.apiKey,
    });
    if (!r.ok || !r.raw) {
      logLine("合成失败: " + ((r.json && r.json.detail) || r.error || "?"));
      return;
    }
    const blob = new Blob([Uint8Array.from(atob(r.raw), (c) => c.charCodeAt(0))], {
      type: "audio/wav",
    });
    const audio = $("audioOut");
    audio.src = URL.createObjectURL(blob);
    audio.style.display = "block";
    logLine("合成完成，音频 " + blob.size + " 字节");
  } catch (e) {
    logLine("合成异常: " + ((e && e.message) || e));
  } finally {
    setBtnWaiting($("btnSynth"), false, "合成", "合成中");
  }
};

$("btnStopEngine").onclick = async () => {
  logLine("停止推理引擎…");
  try {
    const r = await apiCall("/api/engine/stop", "POST", {}, true);
    logLine(r.ok ? "引擎已停止" : "停止失败");
  } catch (e) {
    logLine("停止引擎异常: " + e.message);
  }
};

$("btnCreateProject").onclick = async () => {
  const name = ($("projectName").value || "").trim();
  if (!name) return logLine("请输入项目名称");
  try {
    const r = await api.projectCreate(name);
    if (r && r.ok) {
      logLine("项目已创建: " + name);
      $("projectName").value = "";
      await loadProjects();
    } else {
      logLine("创建失败: " + ((r && r.json && r.json.detail) || (r && r.error) || "?"));
    }
  } catch (e) {
    logLine("创建异常: " + ((e && e.message) || e));
  }
};

$("projectSelect").onchange = () => selectProject($("projectSelect").value);

$("btnUploadAudio").onclick = async () => {
  if (!state.activeProject) return setUploadStatus("请先选择项目", false);
  if (state.uploadBusy) return;
  state.uploadBusy = true;
  const btn = $("btnUploadAudio");
  $("btnUploadText").disabled = true;
  setBtnWaiting(btn, true, "上传音频", "选择中");
  setUploadStatus("正在选择音频文件…", undefined);
  try {
    const r = await api.projectPickUpload(state.activeProject);
    if (r && r.cancelled) {
      setUploadStatus("已取消选择", undefined);
    } else if (r && r.ok) {
      setUploadStatus("音频上传成功，已保存到项目文件夹，可点击 ▶ 预览", true);
      logLine("音频已上传并记录");
      await loadProjects();
      await loadProjectDetail(state.activeProject);
    } else {
      setUploadStatus("音频上传失败：" + ((r && r.json && r.json.detail) || (r && r.error) || "?"), false);
    }
  } catch (e) {
    setUploadStatus("音频上传异常：" + ((e && e.message) || e), false);
  } finally {
    state.uploadBusy = false;
    setBtnWaiting(btn, false, "上传音频", "上传中");
    const p = state.projects.find((x) => (x.slug || x.name) === state.activeProject);
    $("btnUploadText").disabled = !p || !!(p.status === "training" || p.running);
  }
};

$("btnUploadText").onclick = async () => {
  if (!state.activeProject) return setUploadStatus("请先选择项目", false);
  if (state.uploadBusy) return;
  state.uploadBusy = true;
  const btn = $("btnUploadText");
  $("btnUploadAudio").disabled = true;
  setBtnWaiting(btn, true, "上传文字", "选择中");
  setUploadStatus("正在选择文字标注文件…", undefined);
  try {
    const r = await api.projectPickText(state.activeProject);
    if (r && r.cancelled) {
      setUploadStatus("已取消选择", undefined);
    } else if (r && r.ok) {
      setUploadStatus("文字标注已上传并记录，已显示在下方", true);
      logLine("文字标注已上传并记录");
      await loadProjects();
      await loadProjectDetail(state.activeProject);
    } else {
      setUploadStatus("文字上传失败：" + ((r && r.json && r.json.detail) || (r && r.error) || "?"), false);
    }
  } catch (e) {
    setUploadStatus("文字上传异常：" + ((e && e.message) || e), false);
  } finally {
    state.uploadBusy = false;
    setBtnWaiting(btn, false, "上传文字", "上传中");
    const p = state.projects.find((x) => (x.slug || x.name) === state.activeProject);
    $("btnUploadAudio").disabled = !p || !!(p.status === "training" || p.running);
  }
};

/* ---- manual path upload + drag & drop (no native file dialog needed) ---- */
function parsePathList(text) {
  return String(text || "")
    .split(/\r?\n|;|，|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

$("btnUploadPaths").onclick = async () => {
  if (!state.activeProject) return setUploadStatus("请先选择项目", false);
  if (state.uploadBusy) return;
  const paths = parsePathList($("manualPaths").value);
  if (!paths.length) return setUploadStatus("请先粘贴文件完整路径（每行一个）", false);
  state.uploadBusy = true;
  const btn = $("btnUploadPaths");
  btn.disabled = true;
  btn.textContent = "上传中…";
  setUploadStatus("正在读取路径文件…", undefined);
  try {
    const r = await api.projectUploadPaths(state.activeProject, paths, "");
    if (r && r.ok) {
      setUploadStatus("上传成功，已保存到项目文件夹，可点击 ▶ 预览", true);
      logLine("手动路径上传成功: " + paths.length + " 个文件");
      $("manualPaths").value = "";
      await loadProjects();
      await loadProjectDetail(state.activeProject);
    } else {
      setUploadStatus("上传失败：" + ((r && r.json && r.json.detail) || (r && r.error) || "?"), false);
    }
  } catch (e) {
    setUploadStatus("上传异常：" + ((e && e.message) || e), false);
  } finally {
    state.uploadBusy = false;
    btn.disabled = false;
    btn.textContent = "上传路径";
  }
};

const dropZone = $("dropZone");
if (dropZone && api.filePathFor) {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("over");
    if (!state.activeProject) return setUploadStatus("请先选择项目", false);
    if (state.uploadBusy) return;
    const paths = [];
    for (const f of (e.dataTransfer && e.dataTransfer.files) || []) {
      const p = api.filePathFor(f);
      if (p) paths.push(p);
    }
    if (!paths.length) return setUploadStatus("未能读取拖入文件的路径，请改用「上传音频 / 上传文字 / 粘贴路径」", false);
    state.uploadBusy = true;
    setUploadStatus("正在上传拖入的文件…", undefined);
    try {
      const r = await api.projectUploadPaths(state.activeProject, paths, "");
      if (r && r.ok) {
        setUploadStatus("拖拽上传成功，可点击 ▶ 预览", true);
        logLine("拖拽上传成功: " + paths.length + " 个文件");
        await loadProjects();
        await loadProjectDetail(state.activeProject);
      } else {
        setUploadStatus("上传失败：" + ((r && r.json && r.json.detail) || (r && r.error) || "?"), false);
      }
    } catch (err) {
      setUploadStatus("上传异常：" + ((err && err.message) || err), false);
    } finally {
      state.uploadBusy = false;
    }
  });
}

$("projectFiles").addEventListener("click", async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest(".pv") : null;
  if (!btn || !state.activeProject) return;
  const file = btn.dataset.file;
  const audio = $("projectAudio");
  btn.disabled = true;
  btn.textContent = "加载中…";
  setUploadStatus("正在加载音频预览…", undefined);
  try {
    const r = await api.projectAudio(state.activeProject, file);
    if (!r || !r.ok || !r.raw) {
      setUploadStatus("预览失败：" + ((r && (r.json && r.json.detail)) || (r && r.error) || (r && r.raw) || "?"), false);
      return;
    }
    const blob = new Blob([Uint8Array.from(atob(r.raw), (c) => c.charCodeAt(0))], {
      type: r.mime || "audio/wav",
    });
    audio.src = URL.createObjectURL(blob);
    audio.style.display = "block";
    audio.play && audio.play().catch(() => {});
    setUploadStatus("正在播放：" + file, true);
  } catch (e) {
    setUploadStatus("预览异常：" + ((e && e.message) || e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ 预览";
  }
});

$("btnTrain").onclick = async () => {
  if (!state.activeProject) return;
  logLine("开始训练…（进度实时显示，可随时取消）");
  setBtnWaiting($("btnTrain"), true, "开始训练", "训练中");
  try {
    const r = await api.projectTrain(state.activeProject);
    if (r && r.ok) {
      startTrainPoll(state.activeProject);
    } else {
      setBtnWaiting($("btnTrain"), false, "开始训练", "训练中");
      logLine("训练启动失败: " + ((r && r.json && r.json.detail) || (r && r.error) || "?"));
    }
  } catch (e) {
    setBtnWaiting($("btnTrain"), false, "开始训练", "训练中");
    logLine("训练启动异常: " + ((e && e.message) || e));
  }
};

$("btnCancelTrain").onclick = async () => {
  if (!state.activeProject) return;
  logLine("请求取消训练…");
  try {
    await api.projectCancel(state.activeProject);
  } catch (e) {
    logLine("取消失败: " + ((e && e.message) || e));
  }
};

$("btnPreview").onclick = async () => {
  $("ttsText").value = "你好，欢迎使用MTNode AI编排器！";
  logLine("默认语音预览（所选音色朗读固定文案）…");
  $("btnSynth").click();
};

if (api.onProgress) {
  api.onProgress((ev) => {
    if (!ev || ev.phase !== "install") return;
    state.installRunning = true;
    const step =
      (ev.stepLabel || ev.step || "安装中") + (ev.message ? " — " + ev.message : "");
    setInstallProgress(true, step, ev.pct);
    if (ev.step === "agent_recover" || ev.step === "agent_install") {
      logLine("[agent] " + (ev.message || ev.stepLabel || ""));
    }
    if (ev.step === "done" || ev.error) {
      state.installRunning = false;
    }
  });
}

if (api.onLogPanelChanged) {
  api.onLogPanelChanged((data) => syncConsoleBtn(data && data.open));
}

(async () => {
  syncApiPanel();
  const st = await refreshStatus();
  await loadProjects();
  setInterval(async () => {
    await refreshStatus();
    if (!state.trainPollName) await loadProjects();
  }, 5000);
})();
