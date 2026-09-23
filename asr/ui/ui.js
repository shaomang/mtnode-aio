"use strict";
/* 本地语音转写（Qwen3-ASR）插件控制台 —— asr/ui/index.html 的逻辑。
   与 tts / llama / h3 / music3 的控制台同构：状态 + 安装 / 重装 / 补装 ffmpeg + 启停 + 日志 + 设置。
   只经 window.asrApi（asr/preload-asr.js）访问主进程，本窗口没有任何 Node 能力。 */

const api = window.asrApi || null;
const $ = (id) => document.getElementById(id);

let st = {};
let busy = false;
let lastError = "";

function setV(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "v" + (cls ? " " + cls : "");
}
function gpuText(gpu) {
  const list = (gpu && gpu.gpus) || [];
  if (!list.length) return "未检测到 NVIDIA 显卡";
  return list.map((g) => (g.name || "") + (g.driver ? " / 驱动 " + g.driver : "")).join("；");
}
function ffmpegText(ff) {
  if (!ff || !ff.ok) return "缺失 —— 后端无法解码任何音频，请点「补装 ffmpeg」";
  const where = ff.source === "path" ? "系统 PATH" : "安装目录（便携版）";
  return where + " · " + (ff.path || "");
}
function setMsg(text, isErr) {
  const el = $("progMsg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isErr ? "#ff6b6b" : "";
}
function setBar(pct) {
  const b = $("bar");
  if (b) b.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
}

function applyBusy() {
  for (const id of ["btnInstall", "btnFfmpeg", "btnRepair", "btnStart", "btnStop", "btnRelease", "btnDir", "btnModelDir", "btnSaveCfg"]) {
    const b = $(id);
    if (b) b.disabled = !!busy;
  }
  const c = $("btnCancel");
  if (c) c.disabled = !busy;
}

async function loadLog() {
  if (!api || !api.consoleTail) return;
  try {
    const tail = await api.consoleTail(40000);
    const el = $("log");
    if (el) el.textContent = tail || "（暂无日志）";
  } catch {}
}

async function refresh(force) {
  if (!api) return;
  st = (await api.getStatus()) || {};
  const badge = $("badgeState");
  if (badge) {
    const supported = !!st.supported;
    const installed = !!st.installed;
    const running = !!st.running;
    badge.textContent = !supported
      ? "本机无 N 卡 · 不可用"
      : running
        ? "运行中（静默）"
        : installed
          ? "已安装 · 未运行"
          : "未安装";
    badge.className = "badge " + (!supported || !installed ? "warn" : running ? "on" : "off");
  }
  setV("vModel", "ModelScope · " + (st.model || "Qwen/Qwen3-ASR-0.6B"));
  setV("vVad", st.vadModel || "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch");
  setV("vGpu", gpuText(st.gpu), (st.gpu && st.gpu.gpus && st.gpu.gpus.length) ? "" : "err");
  setV("vDir", st.installDir || "尚未选择", st.installDir ? "" : "err");
  setV("vFfmpeg", ffmpegText(st.ffmpeg), st.ffmpeg && st.ffmpeg.ok ? "" : "err");
  setV("vDisk", "模型约 1.9GB + Python 依赖约 3-4GB（CUDA）+ ffmpeg 约 100MB，建议预留 " + (st.diskHintGb || 8) + "GB");

  const idle = $("inIdle");
  if (idle && document.activeElement !== idle) idle.value = String(st.idleMinutes == null ? 10 : st.idleMinutes);
  const hot = $("inHot");
  if (hot && document.activeElement !== hot) hot.value = (st.hotwords || []).join("，");
  const cpu = $("inCpu");
  if (cpu) cpu.checked = !!st.allowCpu;

  const inst = $("btnInstall");
  if (inst) inst.textContent = !st.installed ? "安装" : "重新安装 / 补充安装";
  const ff = $("btnFfmpeg");
  if (ff) ff.style.display = st.ffmpeg && st.ffmpeg.ok ? "none" : "";

  if (!busy && !st.installing) setMsg(st.installing ? "安装进行中…" : "就绪");
  busy = busy || !!st.installing;
  applyBusy();
}

async function runInstall(opts) {
  if (!api || busy) return;
  busy = true;
  applyBusy();
  lastError = "";
  setBar(2);
  setMsg("开始安装…");
  try {
    const r = await api.install(opts || {});
    if (!r || !r.ok) {
      lastError = (r && r.error) || "unknown";
      setMsg("安装失败：" + lastError + (r && r.message ? " — " + r.message : ""), true);
      setBar(100);
    } else {
      setMsg("安装完成，正在静默启动语音后端…");
      setBar(100);
      await api.ensureReady({});
    }
  } catch (e) {
    lastError = String((e && e.message) || e);
    setMsg("安装异常：" + lastError, true);
  }
  busy = false;
  await refresh(true);
  applyBusy();
  await loadLog();
}

async function runFfmpeg(opts) {
  if (!api || busy) return;
  busy = true;
  applyBusy();
  lastError = "";
  setBar(2);
  setMsg("正在补装便携 ffmpeg…");
  try {
    const r = await api.installFfmpeg(opts || {});
    if (!r || !r.ok) {
      lastError = (r && r.error) || "ffmpeg_failed";
      setMsg("ffmpeg 补装失败：" + lastError, true);
    } else {
      setMsg("ffmpeg 已就位。");
    }
  } catch (e) {
    lastError = String((e && e.message) || e);
    setMsg("ffmpeg 补装异常：" + lastError, true);
  }
  busy = false;
  setBar(100);
  await refresh(true);
  applyBusy();
  await loadLog();
}

function bind() {
  const on = (id, fn) => {
    const el = $(id);
    if (el) el.onclick = fn;
  };
  on("btnInstall", () => runInstall({}));
  on("btnFfmpeg", () => runFfmpeg({ force: true }));
  on("btnRepair", async () => {
    if (!api || busy) return;
    busy = true;
    applyBusy();
    setMsg("Agent 正在安装 / 修复…（可关闭此窗，进度在插件卡片上）");
    try {
      await api.agentRecoverInstall({ error: lastError || "" });
    } catch (e) {
      setMsg("Agent 修复异常：" + String((e && e.message) || e), true);
    }
    busy = false;
    await refresh(true);
    applyBusy();
    await loadLog();
  });
  on("btnCancel", async () => {
    if (!api) return;
    await api.cancelInstall();
    setMsg("已请求取消安装…");
  });
  on("btnStart", async () => {
    if (!api) return;
    setMsg("正在启动语音后端…（首次加载模型较慢）");
    const r = await api.start({});
    setMsg(r && r.ok ? "语音后端已启动" : "启动失败：" + ((r && r.error) || "unknown"), !(r && r.ok));
    await refresh(true);
  });
  on("btnStop", async () => {
    if (!api) return;
    await api.stop();
    setMsg("已停止语音后端");
    await refresh(true);
  });
  on("btnRelease", async () => {
    if (!api) return;
    await api.stop();
    setMsg("已释放后端内存（下次转写会自动冷启）");
    await refresh(true);
  });
  on("btnDir", async () => {
    if (!api) return;
    const r = await api.pickInstallDir();
    if (r && r.ok) {
      setMsg("安装目录已设为：" + r.installDir);
      await refresh(true);
    } else if (r && r.error) {
      setMsg("该目录不可用：" + r.error, true);
    }
  });
  on("btnModelDir", async () => {
    if (!api) return;
    const r = await api.pickModelDir();
    if (r && r.ok) {
      setMsg("已有模型目录已设为：" + r.modelDir);
      await refresh(true);
    }
  });
  on("btnClearLog", () => loadLog());
  on("btnSaveCfg", async () => {
    if (!api) return;
    const patch = {
      idleMinutes: Number(($("inIdle") || {}).value) || 0,
      hotwords: String(($("inHot") || {}).value || "")
        .split(/[\n,，、;；]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      allowCpu: !!($("inCpu") || {}).checked,
    };
    await api.setConfig(patch);
    const m = $("cfgMsg");
    if (m) {
      m.textContent = "已保存";
      setTimeout(() => (m.textContent = ""), 1800);
    }
    await refresh(true);
  });

  if (api && api.onProgress) {
    api.onProgress((data) => {
      if (!data) return;
      const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
      setBar(pct);
      setMsg(
        (data.stepLabel || data.step || "") +
          (data.message ? " — " + data.message : "") +
          (pct ? " " + pct + "%" : ""),
        !!data.error || data.step === "error",
      );
      if (data.step === "done" || data.step === "error") {
        busy = false;
        refresh(true).then(loadLog);
      }
    });
  }
}

bind();
applyBusy();
refresh(true).then(loadLog);
setInterval(loadLog, 2500);
setInterval(() => refresh(false), 8000);
