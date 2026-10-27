"use strict";
/* InfiniteTalk 数字人控制台：只经 window.infinitetalkApi 与宿主通信（见 infinitetalk/preload-infinitetalk.js） */
const $ = (id) => document.getElementById(id);
const api = window.infinitetalkApi;
let state = null;
let busy = false;
const picks = { image: "", video: "", audio: "" };

function toast(text) {
  $("progressText").textContent = String(text || "");
}

function setPhase(text, kind) {
  const el = $("phase");
  el.textContent = text;
  el.className = "badge" + (kind ? " " + kind : "");
}

async function refresh() {
  try {
    state = await api.getStatus();
  } catch (e) {
    setPhase("宿主未响应", "err");
    return;
  }
  const s = state;
  setPhase(s.phase === "ready" ? "后端就绪" : s.phase === "idle" ? "已安装 · 未启动" : "未安装",
    s.phase === "ready" ? "ok" : s.phase === "not_installed" ? "err" : "");
  $("ver").textContent = s.version ? "v" + s.version : "";
  if (document.activeElement !== $("installDir")) $("installDir").value = s.installDir || "";
  $("resolution").value = s.resolution || "480p";
  $("steps").value = s.steps || 4;
  $("vramMode").value = s.vramMode || "auto";
  $("btnCancelInstall").disabled = !s.installing;
  $("btnInstall").disabled = !!s.installing || busy;
  $("btnStart").disabled = !s.ready || s.running;
  $("btnStop").disabled = !s.running;
  $("backendText").textContent = s.running
    ? `端口 ${s.port} · 运行中${s.busy ? " · 正在生成" : ""}`
    : s.ready
      ? `端口 ${s.port} · 未启动`
      : "尚未安装";
  if (s.gpu && s.gpu.gpus && s.gpu.gpus.length) {
    const g = s.gpu.gpus[0];
    $("gpuText").textContent = `${g.name} · 显存 ${(g.memMb / 1024).toFixed(1)}GB · 已用 ${(g.usedMb / 1024).toFixed(1)}GB · ${g.util}%`;
  } else {
    $("gpuText").textContent = "未检测到 NVIDIA 显卡";
  }
}

async function refreshLog() {
  try {
    const r = await api.consoleTail(48 * 1024);
    const text = (r && r.text) || "";
    const el = $("log");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = text || "（暂无日志）";
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
    if (!p) {
      toast("这个窗口拿不到文件路径，请用画布节点或在主窗口里选");
      return;
    }
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
$("resolution").onchange = async () => {
  await api.setConfig({ resolution: $("resolution").value });
  refresh();
};
$("steps").onchange = async () => {
  await api.setConfig({ steps: Number($("steps").value) || 4 });
  refresh();
};
$("vramMode").onchange = async () => {
  await api.setConfig({ vramMode: $("vramMode").value });
  refresh();
};
$("btnInstall").onclick = async () => {
  busy = true;
  $("btnInstall").disabled = true;
  $("bar").style.width = "0%";
  const r = await api.install({ installDir: $("installDir").value.trim() });
  busy = false;
  if (r && r.ok) toast("安装完成");
  else toast("安装失败：" + ((r && (r.message || r.error)) || ""));
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
  toast(h && h.ok ? "健康：" + h.port : "后端未响应");
};
$("btnLogRefresh").onclick = refreshLog;
$("btnLogClear").onclick = async () => {
  await api.consoleClear();
  refreshLog();
};
$("btnClose").onclick = () => api.close();

$("btnGen").onclick = async () => {
  if (!picks.audio) return toast("请先拖入语音");
  if (!picks.image && !picks.video) return toast("请先拖入人物图或源视频");
  busy = true;
  $("btnGen").disabled = true;
  $("genResult").textContent = "生成中…（第一段要加载 14B 权重，可能几分钟）";
  const r = await api.generate({
    nodeId: "console",
    imagePath: picks.image,
    videoPath: picks.video,
    audioPath: picks.audio,
    prompt: $("prompt").value,
    resolution: $("resolution").value,
    steps: Number($("steps").value) || undefined,
  });
  busy = false;
  $("btnGen").disabled = false;
  if (r && r.ok) {
    $("genResult").textContent = `完成：${r.path}（${r.mode} · ${r.resolution} · ${r.durationSec}s · ${r.chunks} 段）`;
  } else {
    $("genResult").textContent = "失败：" + ((r && (r.message || r.error)) || "");
  }
};
$("btnCancelGen").onclick = () => api.cancelGenerate("console");

["dropImage", "dropVideo", "dropAudio"].forEach((id) => {
  const el = $(id);
  const kind = el.getAttribute("data-kind");
  bindDrop(el, kind);
});

api.onProgress((d) => {
  if (!d) return;
  if (d.pct != null) $("bar").style.width = Math.max(0, Math.min(100, d.pct)) + "%";
  if (d.message) {
    toast(d.message);
    $("genText").textContent = d.message;
    if (d.phase === "install") $("installHint").textContent = d.message;
  }
  if (d.error) $("genResult").textContent = "失败：" + d.message;
});
api.onConsoleChanged(() => refreshLog());
api.onGpu((g) => {
  if (!g || !g.gpus || !g.gpus.length) return;
  const x = g.gpus[0];
  $("gpuText").textContent = `${x.name} · 显存 ${(x.memMb / 1024).toFixed(1)}GB · 已用 ${(x.usedMb / 1024).toFixed(1)}GB · ${x.util}%`;
});

refresh().then(refreshLog);
setInterval(refresh, 5000);
