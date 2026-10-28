"use strict";
/* FLUX 3 Image Klein 控制台：只做「看状态 / 装 / 启停 / 试生成 / 看日志」，
   业务口径全在宿主 flux3klein/main-flux3klein.js（这里不复制一份规则）。 */
const api = window.flux3kleinApi;
const $ = (id) => document.getElementById(id);
const RATIOS = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "3:2": [1248, 832],
  "4:3": [1152, 896],
  "2:3": [832, 1248],
  "3:4": [896, 1152],
  "9:16": [768, 1344],
};
let last = null;

function log(line) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.textContent += String(line || "") + "\n";
  if (el.textContent.length > 400000) el.textContent = el.textContent.slice(-200000);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function gb(mb) {
  return (Number(mb || 0) / 1024).toFixed(1) + " GB";
}

function render(st) {
  last = st || {};
  const installed = !!(st && st.installed);
  const running = !!(st && st.running);
  $("dot").className = "dot " + (running ? "ok" : installed ? "" : "bad");
  $("phase").textContent = st
    ? (st.installing
        ? "安装中"
        : running
          ? "后端运行中 · " + st.port
          : installed
            ? "已安装 · 后端未运行"
            : "未安装")
    : "读取状态失败";
  $("installDir").textContent = (st && st.installDir) || "（未设置）";
  $("port").textContent = st ? st.port : "—";
  $("precision").textContent = st ? (st.precision === "bf16" ? "BF16" : "INT8") : "—";
  $("vram").textContent = st ? (st.vramMode === "low" ? "低显存（lowvram）" : st.vramMode === "normal" ? "常规" : "自动") : "—";
  $("weights").textContent = st
    ? "INT8 " + (st.installedInt8 ? "✓" : "✗") + " · BF16 " + (st.installedBf16 ? "✓" : "✗")
    : "—";
  if (st && st.gpu && st.gpu.hasNvidia)
    $("gpu").textContent = st.gpu.name + " · " + gb(st.gpu.usedMb) + " / " + gb(st.gpu.totalMb) + " · " + st.gpu.util + "%";
  else $("gpu").textContent = st && st.gpu ? "未检测到 NVIDIA 显卡" : "—";
  $("busy").textContent = st && st.busy ? "生成中…" : "空闲";
  if (st) {
    $("selPrecision").value = st.precision || "int8";
    $("selVram").value = st.vramMode || "auto";
  }
  $("btnStart").disabled = !installed || running;
  $("btnStop").disabled = !running;
}

async function refresh() {
  try {
    const st = await api.status();
    render(st);
  } catch (e) {
    $("phase").textContent = "读取状态失败：" + String((e && e.message) || e);
  }
}

async function loadLog() {
  try {
    const r = await api.tail(400);
    if (r && r.ok) $("log").textContent = r.text || "";
  } catch {}
}

$("btnInstall").addEventListener("click", async () => {
  $("btnInstall").disabled = true;
  $("phase").textContent = "安装中…（步骤与日志见「插件安装」窗）";
  try {
    const r = await api.install({});
    log("[install] " + JSON.stringify(r));
    if (!r || !r.ok) $("phase").textContent = "安装失败：" + ((r && (r.error || r.message)) || "未知错误");
  } catch (e) {
    log("[install] error " + String((e && e.message) || e));
  } finally {
    $("btnInstall").disabled = false;
    refresh();
  }
});

$("btnStart").addEventListener("click", async () => {
  $("btnStart").disabled = true;
  $("phase").textContent = "启动后端…";
  try {
    const r = await api.start();
    log("[start] " + JSON.stringify(r));
  } finally {
    refresh();
  }
});

$("btnStop").addEventListener("click", async () => {
  try {
    await api.stop();
    log("[stop] ok");
  } finally {
    refresh();
  }
});

$("btnPickDir").addEventListener("click", async () => {
  const r = await api.pickInstallDir();
  if (r && r.ok) log("[installDir] " + r.dir);
  refresh();
});

$("btnOpenDir").addEventListener("click", () => {
  if (last && last.installDir) api.openPath(last.installDir);
});

$("btnClear").addEventListener("click", async () => {
  await api.clear();
  $("log").textContent = "";
});

$("selPrecision").addEventListener("change", async () => {
  const r = await api.setConfig({ precision: $("selPrecision").value });
  log("[config] precision -> " + $("selPrecision").value + " " + (r && r.ok ? "ok" : "failed"));
  refresh();
});
$("selVram").addEventListener("change", async () => {
  await api.setConfig({ vramMode: $("selVram").value });
  log("[config] vramMode -> " + $("selVram").value);
  refresh();
});

$("btnTest").addEventListener("click", async () => {
  const ratio = RATIOS[$("testRatio").value] || RATIOS["1:1"];
  $("btnTest").disabled = true;
  $("testResult").textContent = "生成中…";
  try {
    const r = await api.generate({
      prompt: $("testPrompt").value,
      width: ratio[0],
      height: ratio[1],
      steps: Number($("testSteps").value) || 16,
      seed: Number($("testSeed").value) || 0,
      outputDir: last && last.installDir ? last.installDir + "\\output" : undefined,
    });
    if (r && r.ok) {
      $("testResult").textContent = "完成：" + r.path + "（" + r.seconds + "s）";
      log("[test] " + r.path);
    } else {
      $("testResult").textContent = "失败：" + ((r && (r.message || r.error)) || "未知错误");
    }
  } catch (e) {
    $("testResult").textContent = "失败：" + String((e && e.message) || e);
  } finally {
    $("btnTest").disabled = false;
    refresh();
  }
});

$("btnCancel").addEventListener("click", async () => {
  await api.cancelGenerate();
  $("testResult").textContent = "已请求取消";
});

api.onConsole((p) => {
  if (p && p.line) log(p.line);
});
api.onProgress((p) => {
  const bits = [];
  if (p.stepLabel) bits.push(p.stepLabel);
  if (p.message) bits.push(p.message);
  if (p.pct != null) bits.push(Math.round(p.pct) + "%");
  $("progress").textContent = bits.join(" · ") || "—";
});
api.onGpu((g) => {
  if (g && g.hasNvidia) $("gpu").textContent = g.name + " · " + gb(g.usedMb) + " / " + gb(g.totalMb) + " · " + g.util + "%";
});

loadLog();
refresh();
setInterval(refresh, 8000);
