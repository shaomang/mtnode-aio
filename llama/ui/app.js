"use strict";

const api = window.llamaApi;
if (!api) {
  document.body.innerHTML = "<p style='color:#f66;padding:16px'>llamaApi unavailable</p>";
}

let state = {
  tab: "catalog",
  apiKey: "",
  apiVisible: false,
  items: [],
  downloadedIds: new Set(),
  installRunning: false,
  startRunning: false,
  downloadIds: new Set(),
  deployIds: new Set(),
  restoreOnce: false,
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

function applyGpu(gpu) {
  const txt = $("gpuTxt");
  const bar = $("gpuBar");
  if (!gpu || !gpu.memTotal) {
    if (txt) txt.textContent = "—";
    if (bar && bar.parentElement) setBar(bar.parentElement, 0);
    return;
  }
  const usedGb = (gpu.memUsed / 1024).toFixed(1);
  const totalGb = (gpu.memTotal / 1024).toFixed(1);
  const pct = Math.round(gpu.memPct || (gpu.memUsed / gpu.memTotal) * 100);
  if (txt) txt.textContent = pct + "% " + usedGb + "/" + totalGb + " GB";
  if (bar && bar.parentElement) setBar(bar.parentElement, pct);
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

function mkWaitBtn(label) {
  const b = document.createElement("button");
  b.className = "mini waiting";
  b.disabled = true;
  const spin = document.createElement("span");
  spin.className = "spin";
  b.appendChild(spin);
  b.appendChild(document.createTextNode(label || "等待中"));
  return b;
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

async function refreshStatus() {
  const st = await api.getStatus();
  $("installDir").textContent = st.installDir || "未选择安装目录";
  const installed = st.installed || (st.project && st.project.ready);
  const trayMode = !!st.trayMode;
  if ($("installCard")) $("installCard").style.display = trayMode ? "none" : "";
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

  state.downloadedIds = new Set(st.localModelIds || []);

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

  applyGpu(st.gpu);

  if (st.apiStatus) {
    $("apiBase").textContent = st.apiStatus.apiBase || "—";
    $("apiKey").textContent = st.apiStatus.apiKey || "—";
    state.apiKey = st.apiStatus.apiKey || "";
  }

  if (!(st.installing || state.installRunning)) {
    setInstallProgress(false);
  }

  if (state.tab === "local") {
    if (st.apiUp && state.apiKey) await loadLocal();
    else renderLocalFromStatus(st);
  } else if (state.tab === "catalog" && state.items.length) renderItems(state.items);
  return st;
}

function renderLocalFromStatus(st) {
  const models = Array.isArray(st.localModels) ? st.localModels : [];
  const ids = Array.isArray(st.localModelIds) ? st.localModelIds : [];
  if (models.length) {
    state.items = models;
  } else {
    state.items = ids.map((id) => ({
      id,
      kind: "llm",
      status: "idle",
      deployed: false,
    }));
  }
  state.downloadedIds = new Set(state.items.map((x) => x.id));
  renderItems(state.items);
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

function mkRowBtn(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "mini" + (cls ? " " + cls : "");
  b.onclick = onClick;
  return b;
}

function fmtRelease(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = String(d.getUTCFullYear()).slice(-2);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}

function fmtSizeCompact(gb) {
  const x = Number(gb);
  if (!Number.isFinite(x) || x <= 0) return "—";
  if (x < 1) return Math.round(x * 1024) + "M";
  if (x >= 100) return Math.round(x) + "G";
  return x.toFixed(1) + "G";
}

function mkItemMeta(m, isLocal) {
  const meta = document.createElement("div");
  meta.className = "item-meta";
  const date = document.createElement("span");
  const size = document.createElement("span");
  if (isLocal) {
    const ts = m.downloadedAt ? new Date(m.downloadedAt * 1000).toISOString() : "";
    date.textContent = fmtRelease(ts);
    size.textContent = fmtSizeCompact(m.sizeGb);
  } else {
    date.textContent = fmtRelease(m.lastModified || m.createdAt);
    size.textContent = fmtSizeCompact(m.totalSizeGb);
  }
  meta.appendChild(date);
  meta.appendChild(size);
  return meta;
}

function getSizeFilter() {
  const picked = document.querySelector('input[name="sizeFilter"]:checked');
  return picked ? picked.value : "";
}

function syncCatalogFilters() {
  const box = $("catalogFilters");
  if (box) box.style.display = state.tab === "catalog" ? "" : "none";
}

function renderItems(items) {
  const list = $("modelList");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div class="meta">无结果</div>';
    return;
  }
  for (const m of items) {
    const row = document.createElement("div");
    row.className = "item-row";
    const title = m.id || m.name || "?";

    if (state.tab === "catalog") {
      if (state.downloadIds.has(m.id)) {
        row.appendChild(mkWaitBtn("等待中"));
      } else if (!state.downloadedIds.has(m.id)) {
        row.appendChild(mkRowBtn("下载", () => confirmDownload(m), "primary"));
      }
      row.appendChild(mkRowBtn("详情", () => showModelDetail(m)));
    } else {
      const deploying = state.deployIds.has(m.id);
      if (deploying) {
        row.appendChild(mkWaitBtn("等待中"));
      } else if (m.status === "starting") {
        row.appendChild(mkWaitBtn("加载中"));
      } else if (!m.deployed || m.status === "failed" || m.status === "dead" || m.status === "idle") {
        row.appendChild(mkRowBtn("部署", () => startDeploy(m), "primary"));
      } else {
        row.appendChild(
          mkRowBtn("停止", async () => {
            await apiCall("/api/models/stop", "POST", { modelId: m.id });
            await api.syncProvider();
            await loadLocal();
            refreshStatus();
          }, "danger"),
        );
      }
      row.appendChild(mkRowBtn("详情", () => showModelDetail(m, true)));
    }

    row.appendChild(mkItemMeta(m, state.tab === "local"));

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = title;
    name.title = title;
    row.appendChild(name);
    list.appendChild(row);
  }
}

async function confirmDownload(m) {
  const title = m.id || m.name || "?";
  if (
    !confirm(
      "确认下载此模型？\n\n" + title + "\n\n下载将占用磁盘空间，可在 Console 查看进度。",
    )
  ) {
    return;
  }
  state.downloadIds.add(m.id);
  renderItems(state.items);
  logLine("下载 " + title + "…");
  try {
    await apiCall("/api/models/download", "POST", {
      modelId: m.id,
      kind: m.kind || "llm",
      pipelineTag: m.pipelineTag || "",
    });
    logLine("下载完成 " + title);
    state.downloadedIds.add(m.id);
    state.tab = "local";
    document.querySelector('[data-tab="local"]').classList.add("active");
    document.querySelector('[data-tab="catalog"]').classList.remove("active");
    syncCatalogFilters();
    await loadLocal();
  } catch (e) {
    logLine("下载失败: " + e.message);
  } finally {
    state.downloadIds.delete(m.id);
  }
  refreshStatus();
}

async function fetchLocalItem(modelId) {
  try {
    const r = await apiCall("/api/models", "GET");
    const items = r.items || [];
    state.items = items;
    return items.find((x) => x.id === modelId) || null;
  } catch {
    return null;
  }
}

function switchToLocalTab() {
  state.tab = "local";
  const localBtn = document.querySelector('[data-tab="local"]');
  const catBtn = document.querySelector('[data-tab="catalog"]');
  if (localBtn) localBtn.classList.add("active");
  if (catBtn) catBtn.classList.remove("active");
  syncCatalogFilters();
}

async function waitForDeploy(modelId) {
  const title = modelId || "?";
  const done = await waitUntil(async () => {
    const item = await fetchLocalItem(modelId);
    if (!item) return null;
    if (item.status === "running" && item.deployed) return item;
    if (item.status === "failed" || item.status === "dead") return { failed: true, item };
    return null;
  }, 600000, 2000);
  state.deployIds.delete(modelId);
  if (done && done.failed) {
    logLine("部署失败 " + title + (done.item && done.item.error ? ": " + done.item.error : ""));
  } else if (done) {
    logLine("部署完成 " + title);
  } else {
    logLine("部署超时 " + title + "（仍在后台进行，可查看 Console / 引擎日志）");
  }
  return done;
}

async function restoreWantedDeploys() {
  if (!state.apiKey || state.restoreOnce) return;
  let pre;
  try {
    pre = await apiCall("/api/status", "GET");
  } catch (e) {
    return;
  }
  const runningIds = new Set(
    (pre.deployed || []).filter((i) => i.status === "running").map((i) => i.modelId),
  );
  const wanted = (pre.deployed || [])
    .filter((i) => i.status === "starting")
    .map((i) => i.modelId);
  if (runningIds.size && !wanted.length) {
    state.restoreOnce = true;
    return;
  }
  state.restoreOnce = true;
  let r;
  try {
    r = await apiCall("/api/models/restore", "POST");
  } catch (e) {
    state.restoreOnce = false;
    logLine("自动部署失败: " + ((e && e.message) || e));
    return;
  }
  const ids = (r && r.modelIds) || [];
  for (const err of (r && r.errors) || []) {
    logLine("自动部署跳过 " + (err.id || "?") + ": " + (err.error || ""));
  }
  if (!ids.length) return;
  switchToLocalTab();
  const pending = [];
  for (const id of ids) {
    if (runningIds.has(id)) continue;
    const item = await fetchLocalItem(id);
    if (item && item.status === "running" && item.deployed) continue;
    pending.push(id);
    state.deployIds.add(id);
  }
  if (!pending.length) {
    renderItems(state.items);
    return;
  }
  logLine("自动部署: " + pending.join(", "));
  renderItems(state.items);
  Promise.all(pending.map((id) => waitForDeploy(id)))
    .then(async (results) => {
      if (results.some((x) => x && !x.failed)) await api.syncProvider();
      await loadLocal();
      refreshStatus();
    })
    .catch((e) => logLine("自动部署异常: " + ((e && e.message) || e)));
}

async function startDeploy(m) {
  const title = m.id || m.name || "?";
  state.deployIds.add(m.id);
  renderItems(state.items);
  logLine("部署 " + title + "…");
  try {
    await apiCall("/api/models/deploy", "POST", { modelId: m.id });
    const done = await waitForDeploy(m.id);
    if (done && !done.failed) await api.syncProvider();
  } catch (e) {
    logLine("部署失败: " + e.message);
  } finally {
    state.deployIds.delete(m.id);
  }
  await loadLocal();
  refreshStatus();
}

function fmtNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("zh-CN");
}

function fmtBytes(n) {
  const x = Number(n);
  if (!x) return "—";
  if (x >= 1024 ** 3) return (x / 1024 ** 3).toFixed(2) + " GB";
  if (x >= 1024 ** 2) return (x / 1024 ** 2).toFixed(1) + " MB";
  return x + " B";
}

function addDetailField(form, label, value) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (Array.isArray(value)) dd.textContent = value.join(", ");
  else dd.textContent = String(value);
  form.appendChild(dt);
  form.appendChild(dd);
}

async function showModelDetail(m, isLocal) {
  const modal = $("detailModal");
  const form = $("detailForm");
  $("detailTitle").textContent = m.id || "模型详情";
  form.innerHTML = "";
  modal.classList.add("show");

  addDetailField(form, "模型 ID", m.id);
  if (isLocal) {
    addDetailField(form, "本地路径", m.path);
    addDetailField(form, "磁盘占用", m.sizeGb != null ? m.sizeGb + " GB" : fmtBytes(m.sizeBytes));
    addDetailField(form, "预估显存", m.vramGb != null ? "≈" + m.vramGb + " GB" : null);
    addDetailField(form, "部署状态", m.deployed ? "已部署 : " + (m.port || "?") : m.status || "未部署");
    addDetailField(form, "类型", m.kind);
  }

  try {
    const r = await apiCall(
      "/api/catalog/detail?modelId=" + encodeURIComponent(m.id),
      "GET",
      null,
      false,
    );
    const d = r.detail || {};
    addDetailField(form, "作者", d.author);
    addDetailField(form, "类型", d.kind);
    addDetailField(form, "Pipeline", d.pipelineTag);
    addDetailField(form, "库", d.libraryName);
    addDetailField(form, "架构", d.architectures);
    addDetailField(form, "Model Type", d.modelType);
    addDetailField(form, "下载量", fmtNum(d.downloads));
    addDetailField(form, "点赞", fmtNum(d.likes));
    addDetailField(form, "仓库大小", d.totalSizeGb ? d.totalSizeGb + " GB" : fmtBytes(d.totalSizeBytes));
    addDetailField(form, "文件数", d.fileCount);
    addDetailField(form, "最后更新", d.lastModified ? d.lastModified.replace("T", " ").replace("Z", " UTC") : null);
    addDetailField(form, "Gated", d.gated ? "是" : "否");
    addDetailField(form, "私有", d.private ? "是" : "否");
    addDetailField(form, "SHA", d.sha);
    addDetailField(form, "镜像", d.mirror);
    addDetailField(form, "标签", (d.tags || []).slice(0, 24));
    if (d.files && d.files.length) {
      const top = d.files
        .filter((f) => /\.(safetensors|bin|gguf)$/i.test(f.path || ""))
        .slice(0, 8)
        .map((f) => (f.path || "") + " (" + fmtBytes(f.size) + ")")
        .join("\n");
      addDetailField(form, "权重文件", top || null);
    }
  } catch (e) {
    addDetailField(form, "远程详情", "无法获取: " + e.message);
  }

  if (!form.children.length) addDetailField(form, "提示", "无可用信息");
}

$("detailClose").onclick = () => $("detailModal").classList.remove("show");
$("detailModal").onclick = (e) => {
  if (e.target === $("detailModal")) $("detailModal").classList.remove("show");
};

async function loadCatalog() {
  const q = $("searchQ").value.trim();
  const kind = $("kindFilter").value;
  const sizeBand = getSizeFilter();
  const recentOnly = !!($("recentOnly") && $("recentOnly").checked);
  const params = new URLSearchParams({
    q,
    kind,
    limit: "40",
    sizeBand,
    recentOnly: recentOnly ? "true" : "false",
  });
  try {
    const r = await apiCall("/api/catalog?" + params.toString(), "GET", null, false);
    state.items = r.items || [];
    renderItems(state.items);
  } catch (e) {
    logLine("搜索失败: " + e.message);
  }
}

async function loadLocal() {
  try {
    if (!state.apiKey) {
      const st = await api.getStatus();
      if (!st.apiUp) {
        renderLocalFromStatus(st);
        return;
      }
    }
    const r = await apiCall("/api/models", "GET");
    state.items = r.items || [];
    state.downloadedIds = new Set(state.items.map((x) => x.id));
    renderItems(state.items);
  } catch (e) {
    try {
      const st = await api.getStatus();
      renderLocalFromStatus(st);
    } catch {
      logLine("加载本地模型失败: " + e.message);
    }
  }
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.tab = b.dataset.tab;
    syncCatalogFilters();
    if (state.tab === "local") {
      if (state.apiKey) await loadLocal();
      else {
        const st = await api.getStatus();
        renderLocalFromStatus(st);
      }
    } else loadCatalog();
  };
});

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
        await api.syncProvider();
        await refreshStatus();
        // default idle: do not auto-restore deployments
        // await restoreWantedDeploys();
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

$("btnSearch").onclick = () => loadCatalog();
$("searchQ").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadCatalog();
});
document.querySelectorAll('input[name="sizeFilter"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (state.tab === "catalog") loadCatalog();
  });
});
if ($("recentOnly")) {
  $("recentOnly").addEventListener("change", () => {
    if (state.tab === "catalog") loadCatalog();
  });
}

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

if (api.onGpu) {
  api.onGpu((gpu) => applyGpu(gpu));
}

(async () => {
  syncApiPanel();
  syncCatalogFilters();
  const st = await refreshStatus();
  if (st && st.apiUp) {
    await loadLocal();
    // default idle: do not auto-restore deployments
        // await restoreWantedDeploys();
  } else loadCatalog();
  setInterval(refreshStatus, 5000);
})();
