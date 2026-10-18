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
  startRunning: false,
  downloadIds: new Set(),
  deployIds: new Set(),
  downloadProgress: {},
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

let downloadPollTimer = null;

async function fetchDownloads() {
  try {
    const r = await apiCall("/api/downloads", "GET", null, true);
    return Array.isArray(r.items) ? r.items : [];
  } catch {
    return null;
  }
}

function syncDownloadProgress(items) {
  const next = {};
  for (const it of items || []) {
    if (it && it.modelId) next[it.modelId] = it;
  }
  const keys = Object.keys(next);
  const oldKeys = Object.keys(state.downloadProgress);
  let changed = keys.length !== oldKeys.length;
  if (!changed) {
    for (const k of keys) {
      const a = next[k];
      const b = state.downloadProgress[k];
      if (
        !b ||
        Math.round(Number(a.pct) || 0) !== Math.round(Number(b.pct) || 0) ||
        // 未知大小（pct = null）时要靠已下载字节数判定变化，否则这一格永远不重绘。
        (Number(a.received) || 0) !== (Number(b.received) || 0) ||
        String(a.phase || "") !== String(b.phase || "")
      ) {
        changed = true;
        break;
      }
    }
  }
  state.downloadProgress = next;
  return changed;
}

function ensureDownloadPoll() {
  if (downloadPollTimer) return;
  downloadPollTimer = setInterval(async () => {
    const items = await fetchDownloads();
    if (items && syncDownloadProgress(items)) renderItems(state.items);
    if (!Object.keys(state.downloadProgress).length && !state.downloadIds.size) {
      clearInterval(downloadPollTimer);
      downloadPollTimer = null;
    }
  }, 1000);
}

function stopDownloadPollIfIdle() {
  if (downloadPollTimer && !Object.keys(state.downloadProgress).length && !state.downloadIds.size) {
    clearInterval(downloadPollTimer);
    downloadPollTimer = null;
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

async function refreshStatus() {
  const st = await api.getStatus();
  const installed = st.installed || (st.project && st.project.ready);
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

  /* 安装目录对不上（端口上这份脚手架 ≠ MTNode 插件配置的那一份）：在控制台里也明说一句，
     免得用户以为「部署好了却没登记」是别的原因（判定与处理见 llama/main-llama.js 的 rootConflict） */
  const mm = $("rootMismatch");
  if (mm) {
    const live = st.apiStatus && st.apiStatus.installRoot ? String(st.apiStatus.installRoot) : "";
    const cfgDir = String(st.installDir || "");
    const bad = !!live && !!cfgDir && live.replace(/[\\/]+$/, "").toLowerCase() !== cfgDir.replace(/[\\/]+$/, "").toLowerCase();
    mm.style.display = bad ? "" : "none";
    if (bad) {
      $("rootMismatchText").textContent = live + "  ≠  " + cfgDir;
      $("rootMismatchText").title =
        "端口上这份 llama.cpp 的安装目录与 MTNode 插件配置的不一致：模型登记会错位，请在 MTNode 顶栏「插件」的 llama.cpp 卡片上选「换端口起自己的」或「继续用这份」。";
    }
  }

  if (st.apiStatus) {
    $("apiBase").textContent = st.apiStatus.apiBase || "—";
    $("apiKey").textContent = st.apiStatus.apiKey || "—";
    state.apiKey = st.apiStatus.apiKey || "";
  }

  if (st.apiStatus && Array.isArray(st.apiStatus.downloads)) {
    const dlChanged = syncDownloadProgress(st.apiStatus.downloads);
    if (dlChanged && state.tab === "local") renderItems(state.items);
  }
  if (Object.keys(state.downloadProgress).length) ensureDownloadPoll();

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

function mkDownloadProgress(p) {
  const cell = document.createElement("div");
  cell.className = "dl-cell";
  const bar = document.createElement("div");
  bar.className = "bar dl-bar";
  bar.innerHTML = "<i></i>";
  cell.appendChild(bar);
  const txt = document.createElement("span");
  txt.className = "dl-txt";
  cell.appendChild(txt);
  // 后端的 pct 拿不到总量时就是 null —— 以前 Number(null) = 0，于是「未知大小」被画成
  // 刺眼的 0%（用户看到的就是进度永远不动）。现在只认真正的数字，且**总量未知时一律不画百分比**
  // （有 pct 却不给 total 的那种快照，百分比是没法解释的）。
  const rawPct = p ? p.pct : null;
  const total = Number(p && p.total) || 0;
  const received = Number(p && p.received) || 0;
  const hasPct = typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 0 && total > 0;
  const pct = hasPct ? rawPct : null;
  let label = "";
  if (pct !== null) {
    setBar(bar, pct);
    label = Math.round(pct) + "%";
  } else if (total > 0) {
    const derived = (received / total) * 100;
    setBar(bar, derived);
    label = Math.round(derived) + "%";
  } else {
    // 总量未知：进度条钉在 0，但文字必须显示「已下载 X」（看得出在动，而不是卡死）。
    setBar(bar, 0);
    label = received > 0 ? "已下载 " + fmtBytes(received) : String((p && p.message) || "下载中…");
  }
  txt.textContent = label;
  // 悬停能看到后端的原始进度行（含「已下载 X / Y」与阶段文案），排查时不用翻日志。
  const detail = String((p && p.message) || "").trim();
  if (detail) cell.title = detail;
  return cell;
}

function localItemsView() {
  const seen = new Set(state.items.map((x) => x.id));
  const merged = state.items.slice();
  for (const [id] of Object.entries(state.downloadProgress)) {
    if (!seen.has(id)) merged.push({ id, kind: "llm", status: "downloading" });
  }
  return merged;
}

function encModelId(id) {
  return String(id || "")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function deleteLocalModel(m) {
  const title = m.id || m.name || "?";
  const extra = m.deployed
    ? "\n\n该模型正在运行，删除会先停止引擎再移除文件。"
    : "\n\n将删除该模型的全部本地文件，不可恢复。";
  if (!confirm("确认删除已安装模型？\n\n" + title + extra)) return;
  logLine("删除 " + title + "…");
  try {
    await apiCall("/api/models/" + encModelId(m.id), "DELETE", null);
    await api.syncProvider();
    await loadLocal();
    refreshStatus();
    logLine("已删除 " + title);
  } catch (e) {
    logLine("删除失败: " + e.message);
  }
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
    /* 体积未知（仓库里没解析到那一份 GGUF 的文件字节数）时写明「未知」——
       以前一律显示「—」，与「这个仓库确实没给体积」分不开（两者对筛选口径的意义完全不同：
       未知的条目在带体积档位时会被排除）。 */
    size.textContent = m.sizeUnknown ? "未知" : fmtSizeCompact(m.totalSizeGb);
    if (m.sizeUnknown) size.title = "未解析到该仓库将下载的那份 GGUF 的文件大小；选体积档位时它会被排除";
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
  const view = state.tab === "local" ? localItemsView() : items || [];
  if (!view.length) {
    list.innerHTML = '<div class="meta">无结果</div>';
    return;
  }
  for (const m of view) {
    const row = document.createElement("div");
    row.className = "item-row";
    const title = m.id || m.name || "?";

    if (state.tab === "catalog") {
      const dl = state.downloadProgress[m.id];
      if (state.downloadIds.has(m.id) && dl) {
        row.appendChild(mkDownloadProgress(dl));
      } else if (state.downloadIds.has(m.id)) {
        row.appendChild(mkWaitBtn("等待中"));
      } else if (!state.downloadedIds.has(m.id)) {
        if (m.archStatus === "unsupported") {
          /* 后端已经在列表层把「引擎不支持架构」的条目收掉了（见 llama-pack/app/catalog.py
             的 _filter_arch）；走到这里说明是缓存 / 老界面兜底，禁掉下载别再让人白下几个 GB。 */
          const b = mkRowBtn("架构不支持", () => {}, "danger");
          b.disabled = true;
          b.title = "当前 llama.cpp 引擎不支持的架构" + (m.arch ? "：" + m.arch : "");
          row.appendChild(b);
        } else {
          row.appendChild(mkRowBtn("下载", () => confirmDownload(m), "primary"));
        }
      }
      row.appendChild(mkRowBtn("详情", () => showModelDetail(m)));
    } else {
      const deploying = state.deployIds.has(m.id);
      const dl = state.downloadProgress[m.id];
      if (deploying) {
        row.appendChild(mkWaitBtn("等待中"));
      } else if (dl) {
        row.appendChild(mkDownloadProgress(dl));
      } else if (m.status === "starting") {
        row.appendChild(mkWaitBtn("加载中"));
      } else if (m.archStatus === "unsupported") {
        /* 引擎认不出这个架构：后端会直接拒（architecture_not_supported），
           别让用户点一次、看着它走一遍必败的流程。行尾小标写着为什么。 */
        const b = mkRowBtn("架构不支持", () => {}, "danger");
        b.disabled = true;
        b.title = "当前 llama.cpp 引擎不支持的架构" + (m.arch ? "：" + m.arch : "") + "，部署会被拒绝；可用「删除」清掉它释放磁盘";
        row.appendChild(b);
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
      if (!deploying && !dl) {
        row.appendChild(mkRowBtn("删除", () => deleteLocalModel(m), "danger"));
      }
    }

    row.appendChild(mkItemMeta(m, state.tab === "local"));

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = title;
    name.title = title;
    row.appendChild(name);
    /* 架构状态的第二行说明（体积那格只管体积，别再往里塞别的）：
       catalog 的「未确认」= 没读到 GGUF 文件头里的 general.architecture；
       local 的「不支持」= 引擎认不出这个架构，点部署会被后端挡下（原因写在行内）。 */
    if (m.archStatus === "unconfirmed" && state.tab === "catalog") {
      const t = document.createElement("span");
      t.className = "arch-tag warn";
      t.textContent = "架构未确认";
      t.title = "没能读到该仓库 GGUF 文件头里的 general.architecture（网络超时或没有单文件权重），下载与部署仍可尝试";
      row.appendChild(t);
    }
    if (m.archStatus === "unsupported") {
      const t = document.createElement("span");
      t.className = "arch-tag bad";
      t.textContent = "架构不支持";
      t.title = "当前 llama.cpp 引擎不含该架构" + (m.arch ? "：" + m.arch : "") + "，部署会被拒绝；可用「删除」清掉它释放磁盘";
      row.appendChild(t);
    }
    if (m.archStatus === "non-llm") {
      const t = document.createElement("span");
      t.className = "arch-tag warn";
      t.textContent = "非对话架构";
      t.title = "该架构" + (m.arch ? "（" + m.arch + "）" : "") + "不是可对话文本模型（向量 / 文本编码类），在线列表不收它";
      row.appendChild(t);
    }
    list.appendChild(row);
  }
}

async function confirmDownload(m) {
  const title = m.id || m.name || "?";
  if (
    !confirm(
      "确认下载此模型？\n\n" + title + "\n\n下载将占用磁盘空间，可在「已安装」页查看实时进度。",
    )
  ) {
    return;
  }
  state.downloadIds.add(m.id);
  state.downloadProgress[m.id] = {
    modelId: m.id,
    phase: "start",
    pct: 0,
    received: 0,
    total: 0,
    message: "准备下载…",
  };
  switchToLocalTab();
  renderItems(state.items);
  ensureDownloadPoll();
  logLine("下载 " + title + "…");
  try {
    const r = await apiCall("/api/models/download", "POST", {
      modelId: m.id,
      kind: m.kind || "llm",
      pipelineTag: m.pipelineTag || "",
      ggufRepo: m.ggufRepo || "",
      ggufFile: m.ggufFile || "",
      quant: m.quant || "",
    });
    const model = r && r.model;
    if (model && model.ok === false) {
      throw new Error(model.error || "下载失败");
    }
    logLine("下载完成 " + title);
    state.downloadedIds.add(m.id);
    await loadLocal();
  } catch (e) {
    logLine("下载失败: " + e.message);
  } finally {
    state.downloadIds.delete(m.id);
    delete state.downloadProgress[m.id];
    stopDownloadPollIfIdle();
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
    /* 本机文件的架构（读 GGUF 文件头得来）：不支持的会写明「部署会被拒绝」，
       这正是「装了却拉不起来」的那条线索，不再只留一句引擎日志里的话。 */
    addDetailField(form, "架构", m.arch || (m.archStatus === "unconfirmed" ? "未确认（读不出文件头架构）" : ""));
    if (m.archStatus === "unsupported") {
      addDetailField(form, "可用性", "当前 llama.cpp 引擎不支持该架构，部署会被拒绝；可删除该模型释放磁盘");
    }
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
    addDetailField(form, "架构", d.arch || (d.archStatus === "unconfirmed" ? "未确认（读不到 GGUF 文件头）" : d.architectures));
    if (d.archStatus === "unsupported") {
      addDetailField(form, "可用性", "当前 llama.cpp 引擎不支持该架构，不能部署；它也不会出现在在线列表里");
    } else if (d.archStatus === "non-llm") {
      addDetailField(form, "可用性", "该架构不是可对话文本模型（向量 / 文本编码类），在线列表不收它");
    }
    addDetailField(form, "Model Type", d.modelType);
    addDetailField(form, "下载量", fmtNum(d.downloads));
    addDetailField(form, "点赞", fmtNum(d.likes));
    /* 体积口径与列表同源：后端给的是「这次会下载的那一份 GGUF」的大小（不是整仓占用）。 */
    addDetailField(form, "下载大小", d.sizeGb != null ? d.sizeGb + " GB" : d.sizeUnknown ? "未知（未解析到文件大小）" : null);
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
/* 类型下拉（全部 / LLM / Embedding）改选即重搜：以前只有体积档位与「仅半年内」挂了监听，
   下拉换了值什么都不发生，用户以为筛选没生效（得再点一次「搜索」）。 */
if ($("kindFilter")) {
  $("kindFilter").addEventListener("change", () => {
    if (state.tab === "catalog") loadCatalog();
  });
}
if ($("recentOnly")) {
  $("recentOnly").addEventListener("change", () => {
    if (state.tab === "catalog") loadCatalog();
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
