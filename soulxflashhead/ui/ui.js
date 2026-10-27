"use strict";
/* SoulX-FlashHead Lite 控制台：只经 window.soulxflashheadApi 与宿主通信
   （见 soulxflashhead/preload-soulxflashhead.js） */
const $ = (id) => document.getElementById(id);
const api = window.soulxflashheadApi;
let state = null;
let busy = false;
const picks = { image: "", audio: "" };

function toast(text) {
  $("progressText").textContent = String(text || "");
}

function setPhase(text, kind) {
  const el = $("phase");
  el.textContent = text;
  el.className = "badge" + (kind ? " " + kind : "");
}

function gpuLine(g) {
  if (!g || !g.ok) return "未检测到 NVIDIA 显卡";
  return `${g.name} · 显存 ${(g.totalMb / 1024).toFixed(1)}GB · 已用 ${(g.usedMb / 1024).toFixed(1)}GB · ${g.util}%`;
}

function showBench(b) {
  if (!b) return;
  if (b.fps != null) $("kpiFps").textContent = Number(b.fps).toFixed(1);
  if (b.rtf != null) $("kpiRtf").textContent = Number(b.rtf).toFixed(3);
  if (b.msPerChunk != null) $("kpiMs").textContent = Math.round(Number(b.msPerChunk));
  const bits = [];
  if (b.flashAttn !== undefined) bits.push("flash-attn " + (b.flashAttn || "无"));
  else if (b.accel) bits.push("flash-attn " + (b.accel.flash_attn || "无"));
  const sage = b.sage !== undefined ? b.sage : b.accel && b.accel.sage;
  if (sage !== undefined) bits.push("sage " + (sage || "无"));
  if (b.compile !== undefined) bits.push("compile " + (b.compile ? "on" : "off"));
  $("kpiAccel").textContent = bits.join(" · ");
}

async function refresh() {
  try {
    state = await api.getStatus();
  } catch {
    setPhase("宿主未响应", "err");
    return;
  }
  const s = state;
  const phaseText =
    s.phase === "loaded" ? "模型已加载" : s.phase === "ready" ? "后端就绪" : s.phase === "idle" ? "已安装 · 未启动" : "未安装";
  setPhase(phaseText, s.phase === "loaded" || s.phase === "ready" ? "ok" : s.phase === "not_installed" ? "err" : "");
  $("ver").textContent = s.version ? "v" + s.version : "";
  if (document.activeElement !== $("installDir")) $("installDir").value = s.installDir || "";
  $("steps").value = s.steps || 4;
  if (document.activeElement !== $("seed")) $("seed").value = s.seed || 42;
  $("compile").checked = !!s.compile;
  $("btnCancelInstall").disabled = !s.installing;
  $("btnInstall").disabled = !!s.installing || busy;
  $("btnStart").disabled = !s.ready || s.running;
  $("btnStop").disabled = !s.running;
  $("backendText").textContent = s.running
    ? `端口 ${s.port} · 运行中${s.modelLoaded ? " · 模型已加载" : ""}${s.busy ? " · 正在生成" : ""}`
    : s.ready
      ? `端口 ${s.port} · 未启动`
      : "尚未安装";
  $("gpuText").textContent = gpuLine(s.gpu);
  showBench(s.lastBench);
}

async function refreshLog() {
  try {
    const r = await api.consoleTail(48 * 1024);
    const el = $("log");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = (r && r.text) || "（暂无日志）";
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch {}
}

function bindDrop(el, kind) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("set");
  });
  el.addEventListener("dragleave", () => el.classList.remove("set"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    let p = "";
    try {
      p = api.getPathForFile(f) || "";
    } catch {}
    if (!p) return toast("这个窗口拿不到文件路径，请用画布节点或主窗口");
    picks[kind] = p;
    el.textContent = p;
    el.classList.add("set");
  });
}

$("btnPickDir").onclick = async () => {
  const r = await api.pickInstallDir();
  if (r && r.ok) $("installDir").value = r.dir;
};
$("installDir").onchange = async () => {
  await api.setInstallDir($("installDir").value.trim());
  refresh();
};
$("steps").onchange = async () => {
  await api.setConfig({ steps: Number($("steps").value) || 4 });
  refresh();
};
$("seed").onchange = async () => {
  await api.setConfig({ seed: Number($("seed").value) || 42 });
  refresh();
};
$("compile").onchange = async () => {
  await api.setConfig({ compile: $("compile").checked });
  refresh();
};
$("btnInstall").onclick = async () => {
  busy = true;
  $("btnInstall").disabled = true;
  $("bar").style.width = "0%";
  const r = await api.install({ installDir: $("installDir").value.trim() });
  busy = false;
  toast(r && r.ok ? "安装完成" : "安装失败：" + ((r && (r.message || r.error)) || ""));
  if (r && r.ok && r.bench) showBench(r.bench);
  refresh();
};
$("btnCancelInstall").onclick = () => api.cancelInstall();
$("btnStart").onclick = async () => {
  toast("启动中…");
  const r = await api.start();
  toast(r && r.ok ? "后端已启动" : "启动失败：" + ((r && (r.message || r.error)) || ""));
  refresh();
};
$("btnStop").onclick = async () => {
  await api.stop();
  toast("后端已停止");
  refresh();
};
$("btnHealth").onclick = async () => {
  const h = await api.health();
  toast(h && h.ok ? "健康：端口 " + h.port : "后端未响应");
};
$("btnOpenOut").onclick = () => api.openPath(state && state.installDir ? state.installDir : "");
$("btnLogRefresh").onclick = refreshLog;
$("btnLogClear").onclick = async () => {
  await api.consoleClear();
  refreshLog();
};
$("btnClose").onclick = () => api.close();

$("btnBench").onclick = async () => {
  if (!picks.image || !picks.audio) return toast("基准需要人物图 + 语音（用官方示例也行）");
  toast("跑 3 块基准…（首次会加载权重）");
  const r = await api.benchmark({ imagePath: picks.image, audioPath: picks.audio, chunks: 3 });
  if (r && r.ok) {
    showBench(r);
    toast(`基准完成：${Number(r.fps).toFixed(1)} FPS · RTF ${Number(r.rtf).toFixed(3)}`);
  } else {
    toast("基准失败：" + ((r && (r.message || r.error)) || ""));
  }
};

$("btnGen").onclick = async () => {
  if (!picks.image) return toast("请先拖入人物图");
  if (!picks.audio) return toast("请先拖入语音");
  busy = true;
  $("btnGen").disabled = true;
  $("genResult").textContent = "生成中…（首次要加载权重，约 1 分钟）";
  const r = await api.generate({
    nodeId: "console",
    imagePath: picks.image,
    audioPath: picks.audio,
    steps: Number($("steps").value) || undefined,
    seed: Number($("seed").value) || undefined,
  });
  busy = false;
  $("btnGen").disabled = false;
  if (r && r.ok) {
    $("genResult").textContent = `完成：${r.path}（512×512 · ${r.frames} 帧 · ${r.fps} FPS · RTF ${r.rtf} · ${r.chunks} 块）`;
    showBench(r);
  } else {
    $("genResult").textContent = "失败：" + ((r && (r.message || r.error)) || "");
  }
};
$("btnCancelGen").onclick = () => api.cancelGenerate("console");

["dropImage", "dropAudio"].forEach((id) => {
  const el = $(id);
  bindDrop(el, el.getAttribute("data-kind"));
});

api.onProgress((d) => {
  if (!d) return;
  if (d.pct != null) $("bar").style.width = Math.max(0, Math.min(100, d.pct)) + "%";
  if (d.message) {
    toast(d.message);
    $("genText").textContent = d.message;
    if (d.phase === "generate" && d.fps != null) {
      $("kpiFps").textContent = Number(d.fps).toFixed(1);
      $("kpiRtf").textContent = Number(d.rtf).toFixed(3);
      $("kpiMs").textContent = Math.round(Number(d.msPerChunk) || 0);
    }
  }
  if (d.error) $("genResult").textContent = "失败：" + d.message;
});
api.onConsoleChanged(() => refreshLog());
api.onGpu((p) => {
  if (p && p.gpu) $("gpuText").textContent = gpuLine(p.gpu);
});

refresh().then(refreshLog);
setInterval(refresh, 5000);
