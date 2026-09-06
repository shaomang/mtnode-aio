"use strict";

const api = window.ttsApi;
if (!api) {
  document.body.innerHTML = "<p style='color:#f66;padding:16px'>ttsApi unavailable</p>";
}

let state = {
  apiKey: "",
  modelInfo: null,
  trainModeTouched: false,
  apiVisible: false,
  installRunning: false,
  startRunning: false,
  voices: [],
  liveModels: [],
  livePinned: {},
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

// ---------------- 训练中间模型（试听用的「live 音色」） ----------------
//
// 训练每练完一轮，引擎就在 GPT_weights_v2 / SoVITS_weights_v2 里写出一个可以直接
// 推理的权重（s1 的 my_save / s2 的 savee，格式和训练结束后注册进 voices/ 的那份
// 一模一样）。后端把"取最新一轮"包成一个虚拟音色 id：live:<项目>，于是「测试合成」
// 的下拉框里能直接选它试听，而且每点一次合成都自动用当时最新的轮数。
// 要横向比较不同轮次时勾「固定轮次」→ id 变成 live:<项目>@gN_sM，锁住当前这一版。

function livePinId(m) {
  const g = (m && m.gpt) || {};
  const s = (m && m.sovits) || {};
  if (!g.epoch || !s.epoch) return "";
  return "live:" + m.project + "@g" + g.epoch + "_s" + s.epoch;
}

function liveOptId(m) {
  if (!m || !m.project) return "";
  const pin = state.livePinned[m.project];
  // 固定过就用固定 id（**不随训练变**），否则用跟随最新的 live:<项目>
  if (pin && pin.gpt && pin.s2) return "live:" + m.project + "@g" + pin.gpt + "_s" + pin.s2;
  return m.id;
}

function liveUsable(m) {
  if (!m) return false;
  return !!m.usable || !!state.livePinned[m.project];
}

function liveText(m) {
  if (!m) return "";
  const pin = state.livePinned[m.project];
  const g = pin && pin.gpt ? pin.gpt : (m.gpt || {}).epoch || 0;
  const s = pin && pin.s2 ? pin.s2 : (m.sovits || {}).epoch || 0;
  let t = (m.running ? "⏳ 训练中 · " : "🧪 中间模型 · ") + m.project + (pin ? "（已固定）" : "");
  const bits = [];
  const tot = m.epochTotals || {};
  if (g) bits.push("GPT e" + g + (tot.gpt ? "/" + tot.gpt : ""));
  if (s) bits.push("SoVITS e" + s + (tot.sovits ? "/" + tot.sovits : ""));
  if (bits.length) t += " · " + bits.join(" · ");
  if (pin) {
    const lg = (m.gpt || {}).epoch || 0;
    const ls = (m.sovits || {}).epoch || 0;
    if (lg > g || ls > s) t += " · 最新已到 e" + lg + "/e" + ls;
  } else if (!m.usable) {
    t += " · " + (m.reason || "还不能试听");
  } else if (m.updatedLabel) {
    t += " · " + m.updatedLabel + "更新";
  }
  return t;
}

function renderVoices(items, liveItems) {
  state.voices = Array.isArray(items) ? items : [];
  const live = (Array.isArray(liveItems) ? liveItems : []).filter((m) => m && m.project);
  state.liveModels = live;
  const list = $("voiceList");
  const sel = $("voiceSelect");
  if (list) {
    list.innerHTML = "";
    const rows = state.voices.map((v) => ({ v: v })).concat(live.map((m) => ({ m: m })));
    if (!rows.length) {
      list.innerHTML = '<div class="meta">无音色 — 在 voices/ 目录放置 ref.wav + ref.txt + ref.lang，或调用 /api/voices/add 上传</div>';
    } else {
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "item-row";
        const name = document.createElement("div");
        name.className = "name";
        if (r.m) {
          name.textContent = liveText(r.m);
          name.title = r.m.hint || r.m.reason || "";
          const b = document.createElement("span");
          b.className = "badge " + (r.m.running ? "training" : "live");
          b.textContent = r.m.running ? "训练中" : "中间模型";
          row.appendChild(b);
        } else {
          const v = r.v;
          name.textContent = v.id + (v.trained ? " [已训练]" : "") + (v.promptText ? " · " + v.promptText.slice(0, 24) : "");
          name.title = v.refAudio;
        }
        row.appendChild(name);
        list.appendChild(row);
      }
    }
  }
  if (sel) {
    const sig =
      state.voices.map((v) => "r" + v.id).join(",") +
      "|" +
      live.map((m) => "l" + liveOptId(m) + "\u0000" + liveText(m)).join(",");
    const keep = sel.value || "";
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = "";
      if (live.length) {
        const g = document.createElement("optgroup");
        g.label = "训练中间模型（随训练更新）";
        for (const m of live) {
          const opt = document.createElement("option");
          opt.value = liveOptId(m);
          opt.textContent = liveText(m);
          opt.title = m.hint || m.reason || liveText(m);
          opt.disabled = !liveUsable(m);
          g.appendChild(opt);
        }
        sel.appendChild(g);
      }
      const g2 = document.createElement("optgroup");
      g2.label = "已注册音色";
      for (const v of state.voices) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.id + (v.trained ? " [已训练]" : "") + " (" + (v.lang || "auto") + ")";
        g2.appendChild(opt);
      }
      sel.appendChild(g2);
      sel.disabled = !state.voices.length && !live.length;
      sel.dataset.sig = sig;
    }
    // 5 秒一轮的重建不能把用户选中的音色改掉（原来的 bug：每次刷新都跳回第一项）
    const has = Array.prototype.some.call(sel.options, (o) => o.value === keep);
    if (keep && has) {
      sel.value = keep;
    } else if (keep && keep.indexOf("live:") === 0) {
      const base = keep.split("@")[0];
      const alt = Array.prototype.filter.call(sel.options, (o) => o.value === base || o.value.indexOf(base + "@") === 0);
      if (alt.length) sel.value = alt[0].value;
      else if (state.voices.length) sel.value = state.voices[0].id;
    } else if (state.voices.length) {
      sel.value = state.voices.some((v) => v.id === keep) ? keep : state.voices[0].id;
    }
    paintLiveRow();
  }
}

function currentLiveModel() {
  const sel = $("voiceSelect");
  const v = sel ? sel.value : "";
  if (!v || v.indexOf("live:") !== 0) return null;
  const slug = v.slice(5).split("@")[0];
  return state.liveModels.filter((m) => m.project === slug)[0] || null;
}

function paintLiveRow() {
  const row = $("liveRow");
  const info = $("liveInfo");
  const pin = $("livePin");
  const useBtn = $("btnUseLive");
  const badge = $("liveBadge");
  if (!row || !info) return;
  const m = currentLiveModel();
  const show = !!m || state.liveModels.length > 0;
  row.style.display = show ? "flex" : "none";
  if (badge) {
    const src = m || state.liveModels[0];
    badge.textContent = src && src.running ? "训练中" : "中间模型";
    badge.className = "badge " + (src && src.running ? "training" : "live");
    badge.style.display = src ? "" : "none";
  }
  if (useBtn) {
    const first = state.liveModels.filter((x) => x.usable)[0] || state.liveModels[0];
    useBtn.style.display = m || !first ? "none" : "";
    useBtn.dataset.target = first ? liveOptId(first) : "";
    useBtn.textContent = first ? "试听 " + first.project + " 当前轮" : "用它试听";
  }
  if (pin) {
    pin.disabled = !liveUsable(m);
    pin.checked = !!(m && state.livePinned[m.project]);
  }
  if (!m) {
    info.className = "meta";
    const first = state.liveModels[0];
    info.textContent = first
      ? first.usable
        ? "下拉框里已加入「" + first.project + "」当前训练到的模型（" + (first.label || "") + "），选中即可试听；它会随训练自动换新。"
        : "「" + first.project + "」还没有可试听的中间模型：" + (first.reason || "等第一轮练完")
      : "";
    return;
  }
  const pinned = state.livePinned[m.project];
  info.className = "meta" + (liveUsable(m) ? "" : " waiting");
  if (pinned) {
    info.textContent =
      "试听固定用第 " + pinned.gpt + " 轮 GPT + 第 " + pinned.s2 + " 轮 SoVITS（可反复对比同一版）；" +
      "取消勾选后跟随最新（当前 " + (m.label || "") + "）。";
  } else {
    info.textContent = m.hint || m.label || "";
  }
}

async function refreshLiveModels() {
  if (!state.apiKey) return;
  try {
    const j = await apiCall("/api/live-models", "GET", null, true);
    const items = j && Array.isArray(j.items) ? j.items : null;
    if (!items) return; // 老后端没有这个接口：保持现状，其它功能不受影响
    state.liveModels = items;
    renderVoices(state.voices, items);
  } catch (e) {
    /* 后端未就绪或版本较老 */
  }
}

function liveEpochs(m) {
  return [(m && m.gpt && m.gpt.epoch) || 0, (m && m.sovits && m.sovits.epoch) || 0];
}

// 训练状态里已经带着当前中间模型（/api/projects/<名>/status 的 live 字段），
// 直接把它合进列表，不用额外请求 —— 训练时下拉框里的轮数因此每 2.5 秒刷新一次。
function mergeLiveModel(entry) {
  if (!entry || !entry.project) return;
  const arr = state.liveModels.slice();
  let hit = false;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i].project === entry.project) {
      const a = liveEpochs(arr[i]);
      const b = liveEpochs(entry);
      if (a[0] === b[0] && a[1] === b[1] && !!arr[i].running === !!entry.running && !!arr[i].usable === !!entry.usable) return;
      arr[i] = entry;
      hit = true;
      break;
    }
  }
  if (!hit) arr.push(entry);
  state.liveModels = arr;
  renderVoices(state.voices, arr);
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
    renderVoices(st.apiStatus.voices, Array.isArray(st.apiStatus.liveVoices) ? st.apiStatus.liveVoices : []);
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
      // 记下这一行属于哪个项目：切项目瞬间若有旧行残留，点击代理可据此忽略。
      btn.dataset.project = state.activeProject || "";
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

// 切换项目时的即时清理：旧项目的文件行、文字标注、试听音频必须在切项目那一刻消失，
// 否则残留的旧行会配上新项目的 state.activeProject，导致「拿 B 项目请求 A 文件名」。
// loading=true 表示马上会有新项目的数据进来，保留详情区并显示「加载中…」占位。
function clearProjectDetail(loading) {
  const wrap = $("projectDetail");
  const filesEl = $("projectFiles");
  const trTitle = $("transcriptTitle");
  const trEl = $("projectTranscript");
  const audio = $("projectAudio");
  const show = !!loading && !!state.activeProject;
  if (filesEl) filesEl.innerHTML = show ? '<div class="meta">加载中…</div>' : "";
  if (trTitle) trTitle.style.display = "none";
  if (trEl) {
    trEl.style.display = "none";
    trEl.textContent = "";
  }
  if (audio) {
    try {
      audio.pause();
    } catch (e) {}
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch (e) {}
    audio.style.display = "none";
  }
  if (wrap) wrap.style.display = show ? "flex" : "none";
}

async function loadProjectDetail(name) {
  if (!name) {
    clearProjectDetail(false);
    return;
  }
  try {
    const r = await api.projectFiles(name);
    // 请求期间的过期响应：期间可能又切了一次项目，直接丢弃，不覆盖新项目。
    if (name !== state.activeProject) return;
    const p = r && r.ok && r.json && r.json.project;
    if (p) renderProjectDetail(p);
  } catch (e) {
    if (name === state.activeProject) renderProjectDetail(null);
  }
}

// ---------------- 训练方式：重新训练 / 继续迭代 + 数据复用 ----------------
// 后端 /api/projects/<name>/model 告诉我们：有没有已训好的模型、各自训到第几轮、
// 音频是否已经整理过。这里把它呈现成可选项，避免「一按训练就从头重跑一切」。
const TRAIN_FALLBACK_DEFAULTS = { fresh: { s1: 30, s2: 100 }, cont: { s1: 10, s2: 10 } };

function modelDefaults() {
  const d = (state.modelInfo && state.modelInfo.defaults) || TRAIN_FALLBACK_DEFAULTS;
  return {
    fresh: { s1: Number(d.fresh && d.fresh.s1) || 30, s2: Number(d.fresh && d.fresh.s2) || 100 },
    cont: { s1: Number(d.continue && d.continue.s1) || 10, s2: Number(d.continue && d.continue.s2) || 10 },
  };
}

function hasExistingModel() {
  return !!(state.modelInfo && state.modelInfo.hasModel);
}

function chosenMode() {
  if (!hasExistingModel()) return "fresh";
  const el = $("modeContinue");
  return el && el.checked ? "continue" : "fresh";
}

function trainOpts() {
  const mode = chosenMode();
  const o = { mode: mode, reuseData: $("reuseData") ? $("reuseData").checked : true };
  o.dither = $("ditherFill") ? $("ditherFill").checked : true;
  const d = modelDefaults();
  const e1 = parseInt($("s1Epochs") ? $("s1Epochs").value : "", 10);
  const e2 = parseInt($("s2Epochs") ? $("s2Epochs").value : "", 10);
  o.s1Epochs = e1 > 0 ? e1 : mode === "continue" ? d.cont.s1 : d.fresh.s1;
  o.s2Epochs = e2 > 0 ? e2 : mode === "continue" ? d.cont.s2 : d.fresh.s2;
  return o;
}

function modelShort(s) {
  if (!s || !((s.epochsDone || 0) || s.weightsName)) return "无";
  const how = s.resumable ? "训练断点" : s.how === "weights" ? "已导出权重" : "无";
  return "第 " + (s.epochsDone || 0) + " 轮（" + how + "）";
}

function renderTrainMode() {
  const box = $("trainModeBox");
  if (!box) return;
  const mi = state.modelInfo;
  const info = $("modelInfoLine");
  const plan = $("trainPlanHint");
  const rowC = $("rowModeContinue");
  const hintC = $("hintContinue");
  const busy = !!state.trainPollName;
  box.style.display = state.activeProject ? "flex" : "none";
  if (!mi) {
    if (info) info.textContent = state.activeProject ? "正在检测已有模型与已整理数据…" : "选择项目后在这里选训练方式";
    if (plan) plan.textContent = "";
    return;
  }
  const hm = hasExistingModel();
  if (info) {
    const bits = ["GPT " + modelShort(mi.s1), "SoVITS " + modelShort(mi.s2)];
    if (mi.s1 && mi.s1.updatedAt) bits.push("上次训练 " + mi.s1.updatedAt);
    const ds = mi.dataset || {};
    if (ds.clips) bits.push("已整理 " + ds.clips + " 段/" + fmtDur(ds.totalSec));
    info.textContent = (hm ? "已有模型：" : "尚无已训练模型：") + bits.join(" · ");
  }
  if (rowC) rowC.classList.toggle("dis", !hm);
  if ($("modeContinue")) $("modeContinue").disabled = !hm || busy;
  if ($("modeFresh")) $("modeFresh").disabled = busy;
  if ($("reuseData")) $("reuseData").disabled = busy;
  if ($("ditherFill")) $("ditherFill").disabled = busy;
  if (hintC) {
    hintC.textContent = hm
      ? "保留当前模型，在已完成轮数上再加练（默认 +" + modelDefaults().cont.s1 + "/+" + modelDefaults().cont.s2 + " 轮）"
      : "该项目还没有可续训的模型";
  }
  const cont = $("modeContinue");
  const fresh = $("modeFresh");
  if (hm) {
    if (!state.trainModeTouched && cont && !cont.checked && !fresh.checked) cont.checked = true;
  } else if (fresh) {
    fresh.checked = true;
  }
  const d = modelDefaults();
  const mode = chosenMode();
  if ($("labelS1")) $("labelS1").textContent = mode === "continue" ? "GPT 追加轮数" : "GPT 总轮数";
  if ($("labelS2")) $("labelS2").textContent = mode === "continue" ? "SoVITS 追加轮数" : "SoVITS 总轮数";
  if ($("s1Epochs")) {
    $("s1Epochs").placeholder = String(mode === "continue" ? d.cont.s1 : d.fresh.s1);
    $("s1Epochs").disabled = busy;
  }
  if ($("s2Epochs")) {
    $("s2Epochs").placeholder = String(mode === "continue" ? d.cont.s2 : d.fresh.s2);
    $("s2Epochs").disabled = busy;
  }
  if (!plan) { renderTrainWarn(mi, mode, o, s2Planned); return; }
  const o = trainOpts();
  const segs = [];
  let s2Planned = o.s2Epochs;
  if (mode === "continue") {
    const b1 = (mi.s1 && mi.s1.epochsDone) || 0;
    const b2 = (mi.s2 && mi.s2.epochsDone) || 0;
    s2Planned = b2 + o.s2Epochs;
    // 只剩导出权重（训练断点被删）时引擎轮数从 1 重新计，这里要说清楚，
    // 不能写成 30→40 让用户以为只多练 10 轮。
    const re1 = mi.s1 && mi.s1.how === "weights";
    const re2 = mi.s2 && mi.s2.how === "weights";
    if (re2) s2Planned = o.s2Epochs;
    segs.push(
      re1 ? "GPT 以第 " + b1 + " 轮权重为底模再练 " + o.s1Epochs + " 轮（轮数重新计数）" : "GPT " + b1 + "→" + (b1 + o.s1Epochs) + " 轮",
    );
    segs.push(
      re2 ? "SoVITS 以第 " + b2 + " 轮权重为底模再练 " + o.s2Epochs + " 轮（轮数重新计数）" : "SoVITS " + b2 + "→" + (b2 + o.s2Epochs) + " 轮",
    );
  } else {
    segs.push("GPT 从预训练底模重训 " + o.s1Epochs + " 轮");
    segs.push("SoVITS 从预训练底模重训 " + o.s2Epochs + " 轮");
  }
  const ds = mi.dataset || {};
  segs.push(
    o.reuseData
      ? ds.clips
        ? "复用已整理好的 " + ds.clips + " 段音频与文字（不再转换/切分/ASR/提特征）"
        : "复用已整理数据（数据没变时自动跳过处理）"
      : "重新处理全部音频与文字"
  );
  plan.textContent = "本次将：" + segs.join("，") + "。";
  renderTrainWarn(mi, mode, o, s2Planned);
}

/* 「练完有电流音」的两条体检显示在训练卡片上：
   1) 语料带宽（后端 model_info.audioQuality.note，实测算出来的，不是猜的）
   2) 轮数相对语料量是否偏多（经验值由后端 epochGuidance 下发，前后端只有一份） */
function renderTrainWarn(mi, mode, o, s2Planned) {
  const warn = $("trainWarn");
  if (!warn) return;
  const lines = [];
  const aq = (mi && mi.audioQuality) || {};
  if (aq.note) lines.push("⚠ " + aq.note);
  const g = (mi && mi.epochGuidance) || {};
  const per = Number(g.perMinute) || 15;
  const floor = Number(g.safeFloor) || 40;
  const sec = Number((mi && mi.dataset && mi.dataset.totalSec) || aq.clipsSec || 0);
  const total = Number(s2Planned) || 0;
  if (sec > 0 && total > 0) {
    const cap = Math.max(floor, Math.floor((sec / 60) * per));
    if (total > cap) {
      lines.push(
        "⚠ 语料约 " + fmtDur(sec) + "，SoVITS 这次要练到第 " + total + " 轮，超过这个量级的经验上限（约 " + cap +
          " 轮）——练过头容易出电流音 / 金属声。建议改成 " + cap + " 轮以内；" +
          "或者练的过程中就在「测试合成」里选训练中间模型 + 勾「固定轮次」，听到哪轮最好就停在哪轮。"
      );
    }
  }
  warn.style.display = lines.length ? "block" : "none";
  warn.textContent = lines.join("\n");
}

async function loadModelInfo(name) {
  state.modelInfo = null;
  state.trainModeTouched = false;
  if (!name) {
    renderTrainMode();
    return;
  }
  try {
    if (api.projectModel) {
      const r = await api.projectModel(name);
      const j = r && r.ok && r.json ? r.json : null;
      if (j && (j.ok || j.hasModel !== undefined)) state.modelInfo = j;
    }
  } catch (e) {
    /* 旧后端没有该接口：退回用训练状态里带的 model 字段 */
  }
  if (!state.modelInfo) {
    try {
      const r = await api.projectStatus(name);
      const p = r && r.ok && r.json && r.json.project;
      if (p && p.model) {
        state.modelInfo = {
          ok: true,
          hasModel: !!((p.model.s1 && p.model.s1.canContinue) || (p.model.s2 && p.model.s2.canContinue)),
          s1: p.model.s1 || {},
          s2: p.model.s2 || {},
          dataset: { clips: 0, totalSec: p.durationSec || 0 },
          defaults: TRAIN_FALLBACK_DEFAULTS,
        };
      }
    } catch (e) {}
  }
  renderTrainMode();
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
    const bits = [pos + (p.phaseLabel || p.phase || "训练中"), Math.round(p.pct || 0) + "%"];
    if (p.epoch) bits.push("第 " + p.epoch + "/" + (p.epochTotal || "?") + " 轮");
    if (p.loss !== undefined && p.loss !== null && p.loss !== "") bits.push("loss " + p.loss);
    if (p.trainMode === "continue") bits.push("继续迭代");
    else if (p.trainMode === "fresh") bits.push("重新训练");
    phase.textContent = bits.join(" · ");
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
  // 先清空旧项目的文件区/试听音频再异步取新数据：避免切项目瞬间出现
  // 旧文件行 + 新项目名 的错乱（用户误听到上一个项目的内容）。
  clearProjectDetail(!!name);
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
  // 训练完成的项目允许「重新训练」（音频/文本重新上传后仍需重训才能生效，
  // 此前 status==="trained" 会永久禁用按钮，导致「有数据却无法训练」）。
  $("btnTrain").disabled = !p || busy || (p.audioCount || 0) < 1;
  $("btnCancelTrain").disabled = !busy;
  if (busy) {
    showTrainBox();
    renderTrainProgress(p);
  } else {
    hideTrainBox();
  }
  if (busy) {
    const t = p && p.trainMode === "continue" ? "modeContinue" : p && p.trainMode === "fresh" ? "modeFresh" : "";
    if (t && $(t)) $(t).checked = true;
  }
  renderTrainMode();
  loadProjectDetail(name);
  loadModelInfo(name);
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
  refreshLiveModels(); // 一开始训练就把「中间模型」选项摆进测试合成，不用等第一轮
  state.trainPollTimer = setInterval(async () => {
    try {
      const r = await api.projectStatus(state.trainPollName);
      const p = r && r.ok && r.json && r.json.project;
      if (!p) return;
      renderTrainProgress(p);
      // 训练状态里就带当前中间模型（不用额外请求）：每练完一轮这里就会换轮数
      if (p.live && p.live.project) mergeLiveModel(p.live);
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
        await refreshLiveModels();
        await loadProjects();
        loadModelInfo(state.activeProject);
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

$("voiceSelect").addEventListener("change", () => paintLiveRow());

$("btnUseLive").onclick = () => {
  const sel = $("voiceSelect");
  const target = ($("btnUseLive").dataset.target || "").trim();
  if (!sel || !target) return;
  sel.value = target;
  renderVoices(state.voices, state.liveModels);
  logLine("已选中训练中间模型：" + liveText(currentLiveModel() || {}));
  if ($("ttsText")) $("ttsText").focus();
};

$("livePin").onchange = (ev) => {
  const m = currentLiveModel();
  if (!m) {
    ev.target.checked = false;
    return;
  }
  const sel = $("voiceSelect");
  if (ev.target.checked) {
    const pid = livePinId(m);
    if (!pid) {
      logLine("还不能固定轮次：GPT 与 SoVITS 至少要各练完一轮");
      ev.target.checked = false;
      return;
    }
    const g = (m.gpt || {}).epoch || 0;
    const s = (m.sovits || {}).epoch || 0;
    state.livePinned[m.project] = { gpt: g, s2: s };
    if (sel) sel.value = pid;
    logLine("已固定 " + m.project + " 的中间模型：GPT 第 " + g + " 轮 · SoVITS 第 " + s + " 轮（反复试听都是这一版）");
  } else {
    delete state.livePinned[m.project];
    if (sel) sel.value = m.id;
    logLine("已取消固定：" + m.project + " 的中间模型重新跟随训练最新轮次");
  }
  saveLivePins();
  renderVoices(state.voices, state.liveModels);
};

function saveLivePins() {
  try {
    localStorage.setItem("ttsLivePinned", JSON.stringify(state.livePinned));
  } catch (e) {
    /* 面板没有 storage 也不影响功能 */
  }
}

function loadLivePins() {
  try {
    const raw = localStorage.getItem("ttsLivePinned");
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === "object") state.livePinned = obj;
  } catch (e) {
    state.livePinned = {};
  }
}

$("btnSynth").onclick = async () => {
  const text = ($("ttsText").value || "").trim();
  const voice = $("voiceSelect").value || "";
  if (!text) return logLine("请输入文本");
  const live = currentLiveModel();
  if (live) {
    // 试听中间模型：说清楚这次点下去会用哪一轮（服务端按提交时刻取最新）
    const pinned = state.livePinned[live.project];
    logLine(
      "合成中… voice=" + voice +
        " · 中间模型=" + (pinned ? "固定 GPT e" + pinned.gpt + " · SoVITS e" + pinned.s2 : live.label || "最新一轮") +
        (pinned ? "" : "（以提交时盘上最新一轮为准）")
    );
  } else {
    logLine("合成中… voice=" + (voice || "default"));
  }
  setBtnWaiting($("btnSynth"), true, "合成", "合成中");
  try {
    const r = await api.apiFetch({
      path: "/api/tts",
      method: "POST",
      /* 采样步数不再由面板发送：一律用后端 infer.json 里存的默认值 */
      body: { text, voice, speed: 1.0, media_type: "wav" },
      apiKey: state.apiKey,
    });
    if (!r.ok || !r.raw) {
      const detail = (r.json && (r.json.detail || r.json.error)) || r.error || "?";
      logLine("合成失败: " + detail);
      if (String(detail).indexOf("还不能试听") >= 0 || (r.json && r.json.errorCode === "live_model_unready")) {
        await refreshLiveModels(); // 轮数变了：立刻把最新状态显示出来
      }
      return;
    }
    const blob = new Blob([Uint8Array.from(atob(r.raw), (c) => c.charCodeAt(0))], {
      type: "audio/wav",
    });
    const audio = $("audioOut");
    audio.src = URL.createObjectURL(blob);
    audio.style.display = "block";
    logLine("合成完成，音频 " + blob.size + " 字节" + (live ? "（具体用了哪一版权重见「运行日志」）" : ""));
    if (live) await refreshLiveModels();
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
  const svc = await ensureServiceRunning();
  if (!svc.ok) return setUploadStatus("上传失败: " + (svc.error || "服务未就绪"), false);
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
  const svc = await ensureServiceRunning();
  if (!svc.ok) return setUploadStatus("上传失败: " + (svc.error || "服务未就绪"), false);
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
  const proj = state.activeProject;
  const owner = btn.dataset.project || "";
  // 旧项目残留的行：按钮所属项目与当前 activeProject 不一致 → 忽略这次点击。
  if (owner && owner !== proj) return;
  const file = btn.dataset.file;
  const audio = $("projectAudio");
  btn.disabled = true;
  btn.textContent = "加载中…";
  setUploadStatus("正在加载音频预览…", undefined);
  try {
    const r = await api.projectAudio(proj, file);
    // 请求期间用户已切项目：丢弃这份音频，不去改 #projectAudio / 状态提示。
    if (proj !== state.activeProject) return;
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

/* 训练/上传都依赖本地后端。服务未运行时点「开始训练」此前只会报
   "connect ECONNREFUSED" —— 项目明明有音频和文字却无法开始训练。
   这里先探测后端，未就绪则自动拉起并等待就绪，再发起训练请求。 */
async function ensureServiceRunning() {
  try {
    const st = await api.getStatus();
    if (st && st.apiUp) return { ok: true };
  } catch (e) {
    /* fall through to start */ void e;
  }
  logLine("服务未运行，正在自动启动…");
  let sr;
  try {
    sr = await api.start();
  } catch (e) {
    return { ok: false, error: "服务启动异常: " + ((e && e.message) || e) };
  }
  if (!(sr && sr.ok)) return { ok: false, error: (sr && sr.error) || "服务启动失败" };
  const ready = await waitUntil(async () => {
    const s2 = await api.getStatus();
    return s2 && s2.apiUp ? s2 : null;
  }, 180000, 1500);
  if (!ready) return { ok: false, error: "服务启动超时（可查看 Console 日志）" };
  return { ok: true };
}

$("btnTrain").onclick = async () => {
  if (!state.activeProject) return;
  setBtnWaiting($("btnTrain"), true, "开始训练", "启动中");
  try {
    const svc = await ensureServiceRunning();
    if (!svc.ok) {
      setBtnWaiting($("btnTrain"), false, "开始训练", "训练中");
      logLine("训练启动失败: " + (svc.error || "服务未就绪"));
      return;
    }
    const o = trainOpts();
    logLine(
      (o.mode === "continue" ? "继续迭代训练…" : "重新训练…") +
        (o.reuseData ? "（复用已整理数据）" : "（重新处理数据）") +
        (o.dither ? "（高频空带填充开）" : "") +
        " GPT " + o.s1Epochs + " 轮 / SoVITS " + o.s2Epochs + " 轮"
    );
    setBtnWaiting($("btnTrain"), true, "开始训练", "训练中");
    const r = await api.projectTrain(state.activeProject, o);
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

if ($("modeContinue")) $("modeContinue").onchange = () => {
  state.trainModeTouched = true;
  renderTrainMode();
};
if ($("modeFresh")) $("modeFresh").onchange = () => {
  state.trainModeTouched = true;
  renderTrainMode();
};
if ($("reuseData")) $("reuseData").onchange = () => renderTrainMode();
if ($("s1Epochs")) $("s1Epochs").oninput = () => renderTrainMode();
if ($("s2Epochs")) $("s2Epochs").oninput = () => renderTrainMode();

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
  loadLivePins();
  const st = await refreshStatus();
  await loadProjects();
  setInterval(async () => {
    await refreshStatus();
    if (!state.trainPollName) await loadProjects();
  }, 5000);
})();
