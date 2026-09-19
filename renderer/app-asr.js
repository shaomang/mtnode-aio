"use strict";
/* ============================================================================
 * 本地语音转写（Qwen3-ASR）渲染层
 * ----------------------------------------------------------------------------
 * 需求：把「音频输入」（input_audio / 素材音频条目 / 语音生成产物 / 工具与函数节点的
 *      音频端子）接到文字处理节点（proc_text 普通与智能模式、agent_task）后，
 *      运行时自动把音频转成文字，并以「【音频转写】…」段落注入提示词 / 任务描述。
 *
 * 分工：
 *   · 后端与缓存都在主进程（asr/main-asr.js）：静默起停、随 MTNode 退出、空闲释放、
 *     全局媒体互斥、按 路径+mtime+size+热词指纹 缓存；
 *   · 本文件只管：探测后端状态、首次连接时的安装弹窗、节点内转写文本的展示 / 编辑 /
 *     重新转写、把转写文本喂给提示词组装（同步取用，见 asrTextItemsOf / asrTranscriptBlockFor）。
 *
 * 与既有「图像 → 视觉模型」的分工一致：音频只被文字节点消费，转写产物是纯文本。
 * ==========================================================================*/

const ASR_SKILL_NAME = "asr-local-install";
const ASR_STATUS_TTL_MS = 4000;

let _asrStatus = null;
let _asrStatusAt = 0;
let _asrStatusPromise = null;
/** 转写文本的内存镜像：path(小写) → text；运行时同步取用（见 asrTranscriptOf） */
const _asrMem = new Map();
/** 节点内编辑防抖定时器：nodeId → timer */
const _asrEditTimers = new Map();

function asrHasApi() {
  return !!(window.api && window.api.asrStatus);
}
function asrT(s, vars) {
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(s, vars) : s;
}

/* 文字处理节点：本需求只服务这两类（音频 → 文字） */
function isAsrConsumerNode(node) {
  return !!(node && (node.kind === "agent_task" || node.kind === "proc_text"));
}
/* 智能节点（agent_task / 文本智能模式）：转写文本追加到任务描述 */
function isAsrAgentNode(node) {
  return !!(node && (node.kind === "agent_task" || (node.kind === "proc_text" && node.agent)));
}

function asrBlockTitle(title) {
  return asrT("音频转写") + (title ? " · " + title : "");
}

/* ---- 状态（带 TTL 缓存，避免每个节点每次运行都探一遍） ---- */
async function asrStatus(force) {
  if (!asrHasApi()) return null;
  const now = Date.now();
  if (!force && _asrStatus && now - _asrStatusAt < ASR_STATUS_TTL_MS) return _asrStatus;
  if (_asrStatusPromise) return _asrStatusPromise;
  _asrStatusPromise = window.api
    .asrStatus()
    .then((st) => {
      _asrStatus = st || null;
      _asrStatusAt = Date.now();
      _asrStatusPromise = null;
      return _asrStatus;
    })
    .catch(() => {
      _asrStatusPromise = null;
      return _asrStatus;
    });
  return _asrStatusPromise;
}
function asrInvalidateStatus() {
  _asrStatusAt = 0;
}

/* ---- 音频来源解析 ---- */
function asrAudioValueOfWire(w, consumer) {
  const src = w && nodeById(w.from);
  if (!src || w.rel || wireFromIsControl(w)) return null;
  const fi = Number(w.fromIndex || 0);
  if (typeof wireSourceMediaType === "function" && wireSourceMediaType(src, fi) !== "audio")
    return null;
  const portIdx =
    typeof refInputIdxFor === "function" ? refInputIdxFor(consumer, src, 0, w) : fi;
  const v = typeof valueForInput === "function" ? valueForInput(src, portIdx, consumer) : null;
  if (!v || v.kind !== "audio" || !v.path) return null;
  const title =
    (typeof itemTitleOf === "function" ? itemTitleOf(src, portIdx, consumer) : "") ||
    src.title ||
    asrT("音频");
  return { src, path: String(v.path), title, portIdx };
}
/** 节点接进来的全部音频（按连线顺序） */
function asrAudioInputsOf(node) {
  if (!isAsrConsumerNode(node) || typeof wiresTo !== "function") return [];
  const out = [];
  for (const w of wiresTo(node.id)) {
    const a = asrAudioValueOfWire(w, node);
    if (a) out.push(a);
  }
  return out;
}
/* 该来源是否是「音频来源」（供 resolveRefs 的连线自动注入放行） */
function isAsrAudioSourceKind(src, portIdx) {
  if (!src) return false;
  try {
    return typeof wireSourceMediaType === "function"
      ? wireSourceMediaType(src, Number(portIdx || 0)) === "audio"
      : false;
  } catch {
    return false;
  }
}

/** 取该音频在本节点已有的转写文本：node.asrTranscripts（持久化）优先，其次内存镜像 */
function asrTranscriptOf(consumer, path) {
  const key = String(path || "").toLowerCase();
  if (!key) return null;
  const list = (consumer && consumer.asrTranscripts) || [];
  for (const t of list) {
    if (String(t && t.path ? t.path : "").toLowerCase() === key && t.text != null)
      return t;
  }
  if (_asrMem.has(key)) return { path, text: _asrMem.get(key) };
  return null;
}

/** allTextItems 钩子：音频来源 → 已转写文本作为背景块（同步；没有转写就返回 null 走原逻辑） */
function asrTextItemsOf(src, consumer, portIdx) {
  if (!consumer || !isAsrConsumerNode(consumer) || !src) return null;
  if (!isAsrAudioSourceKind(src, portIdx)) return null;
  let v = null;
  try {
    v = valueForInput(src, portIdx == null ? 0 : portIdx, consumer);
  } catch {
    return null;
  }
  if (!v || v.kind !== "audio" || !v.path) return null;
  const hit = asrTranscriptOf(consumer, v.path);
  if (!hit) return null;
  const title =
    (typeof itemTitleOf === "function"
      ? itemTitleOf(src, portIdx == null ? 0 : portIdx, consumer)
      : "") || src.title;
  return [{ title: asrBlockTitle(title), text: String(hit.text) }];
}

/** resolveRefs 钩子：这条连线的来源若是音频且有转写 → 给出背景块（否则 null 走原有口径） */
function asrTranscriptBlockFor(consumer, src, portIdx) {
  if (!consumer || !isAsrConsumerNode(consumer) || !src) return null;
  if (!isAsrAudioSourceKind(src, portIdx)) return null;
  let v = null;
  try {
    v = valueForInput(src, portIdx == null ? 0 : portIdx, consumer);
  } catch {
    return null;
  }
  if (!v || v.kind !== "audio" || !v.path) return null;
  const hit = asrTranscriptOf(consumer, v.path);
  if (!hit) return null;
  const title =
    (typeof itemTitleOf === "function"
      ? itemTitleOf(src, portIdx == null ? 0 : portIdx, consumer)
      : "") || src.title;
  return { title: asrBlockTitle(title), text: String(hit.text) };
}

/* ---- 提示词注入：agent_task 的任务描述里追加「【音频转写】…」段落 ---- */
function asrTaskAppendText(node) {
  if (!isAsrAgentNode(node)) return "";
  const list = (node && node.asrTranscripts) || [];
  if (!list.length) return "";
  const parts = [];
  for (const t of list) {
    const body = String(t.text || "").trim();
    if (!body) continue;
    parts.push(
      "【" + asrT("音频转写") + (t.title ? " · " + t.title : "") + "】\n" + body,
    );
  }
  return parts.join("\n\n");
}

/* ---- 节点上的热词 / 全局默认热词 ---- */
function asrHotwordsOf(node) {
  const raw = String((node && node.asrHotwords) || "");
  return raw
    .split(/[\n,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---- 错误文案 ---- */
function asrErrText(r) {
  const code = (r && (r.error || r.message)) || "";
  const map = {
    not_installed: asrT("本地语音后端尚未安装：请点节点上的「一键安装」或到「插件」里安装「本地语音转写」"),
    no_cuda: asrT("未检测到可用的 NVIDIA 显卡，本地语音转写不可用（可在插件里选「仍装 CPU 版（很慢）」）"),
    no_venv: asrT("语音后端缺少 Python 环境，请在插件卡片里点「自我修复」"),
    audio_missing: asrT("音频文件不存在或已被移动"),
    busy_media: (r && r.message) || asrT("已有音视频任务进行中，请稍后再试"),
    backend_exited: asrT("语音后端起不来（已退出），请查看控制台日志或点「自我修复」"),
    backend_start_timeout: asrT("语音后端启动超时（首次要加载模型，请稍后重试）"),
    decode_failed: asrT("音频解码失败（后端缺少 ffmpeg？请在插件里点「自我修复」）"),
    no_ffmpeg: asrT("后端缺少 ffmpeg，无法解码该音频格式（请在插件里点「自我修复」）"),
    model_load_failed: asrT("模型加载失败，请查看控制台日志或点「自我修复」"),
  };
  return map[code] || (r && r.message) || code || asrT("转写失败");
}

/* ============================ 运行前准备 ============================ */
/**
 * 文字节点运行前的音频准备（在 playNodeBody 里、上游补跑之前调用）：
 *   · 没有音频输入 → 直接放行；
 *   · 无 N 卡 / 未安装 → 节点上标状态并拦下本轮（不静默当作没输入）；
 *   · 逐个音频转写（命中缓存即秒回），结果写进 node.asrTranscripts 供提示词同步取用。
 * 返回 { ok:false, error } 时调用方必须中止本轮。
 */
async function asrPrepareForRun(node) {
  if (!isAsrConsumerNode(node) || !asrHasApi()) return { ok: true };
  const audios = asrAudioInputsOf(node);
  if (!audios.length) {
    if (Array.isArray(node.asrTranscripts) && node.asrTranscripts.length) {
      node.asrTranscripts = [];
      node.asrState = "";
    }
    return { ok: true };
  }
  const st = await asrStatus(true);
  if (!st) return { ok: false, error: "no_api", message: asrT("本地语音模块不可用") };
  if (!st.supported) {
    node.asrState = "no_cuda";
    node.error = asrErrText({ error: "no_cuda" });
    toast(node.error, "warn");
    return { ok: false, error: "no_cuda", message: node.error };
  }
  if (!st.installed) {
    node.asrState = "not_installed";
    node.error = asrErrText({ error: "not_installed" });
    asrOpenInstallDialog({ reason: "run" });
    return { ok: false, error: "not_installed", message: node.error };
  }
  node.error = null;
  const out = [];
  for (const a of audios) {
    const hot = asrHotwordsOf(node);
    let r = null;
    try {
      r = await window.api.asrTranscribe({
        path: a.path,
        hotwords: hot,
        nodeId: node.id,
        workflowId: (S.wf && S.wf.id) || "",
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (!r || !r.ok) {
      node.asrState = "error";
      node.error = asrErrText(r);
      toast(node.error, "err");
      asrInvalidateStatus();
      return { ok: false, error: (r && r.error) || "asr_failed", message: node.error };
    }
    _asrMem.set(String(a.path).toLowerCase(), String(r.text || ""));
    out.push({
      path: a.path,
      title: a.title,
      text: String(r.text || ""),
      cached: !!r.cached,
      segments: Number(r.segments) || 0,
      duration_sec: Number(r.duration_sec) || 0,
      at: Date.now(),
    });
  }
  node.asrTranscripts = out;
  node.asrState = "ok";
  node.error = null;
  try {
    scheduleSave();
  } catch {}
  try {
    renderCanvas();
  } catch {}
  return { ok: true };
}

/** 「重新转写」：清掉缓存与节点上的旧结果，然后单独跑一次转写（不重跑整个节点）。 */
async function asrRetranscribeNode(node, path) {
  if (!node || !asrHasApi()) return { ok: false };
  await window.api.asrCacheClear({ path: path || "" });
  _asrMem.delete(String(path || "").toLowerCase());
  node.running = true;
  try {
    renderCanvas();
  } catch {}
  try {
    const r = await asrPrepareForRun(node);
    if (!r.ok && r.error) toast(asrErrText({ error: r.error, message: r.message }), "warn");
    else toast(asrT("已重新转写"), "ok");
    return r;
  } finally {
    node.running = false;
    try {
      scheduleSave();
      renderCanvas();
    } catch {}
  }
}

/* ---- 节点内编辑转写文本：覆盖该音频的缓存（一处编辑全画布生效） ---- */
function asrCommitEdit(node, path, text) {
  const key = String(path || "").toLowerCase();
  _asrMem.set(key, String(text || ""));
  if (Array.isArray(node.asrTranscripts)) {
    for (const t of node.asrTranscripts) {
      if (String(t.path || "").toLowerCase() === key) {
        t.text = String(text || "");
        t.edited = true;
      }
    }
  }
  const key2 = node.id + "\u0000" + key;
  if (_asrEditTimers.has(key2)) clearTimeout(_asrEditTimers.get(key2));
  _asrEditTimers.set(
    key2,
    setTimeout(() => {
      _asrEditTimers.delete(key2);
      if (!asrHasApi() || !window.api.asrCacheSet) return;
      window.api
        .asrCacheSet({ path, text: String(text || ""), hotwords: asrHotwordsOf(node) })
        .catch(() => {});
    }, 400),
  );
  try {
    scheduleSave();
  } catch {}
}

/* ============================ 节点内的转写区块 ============================ */
/** 节点 body 尾部追加「本地语音转写」区块（无音频连线时不显示，不占版面） */
function asrAppendNodeBody(node, body) {
  if (!body || !isAsrConsumerNode(node)) return;
  const audios = asrAudioInputsOf(node);
  if (!audios.length) return;
  const wrap = document.createElement("div");
  wrap.className = "n-asr";

  const hdr = document.createElement("div");
  hdr.className = "n-asr-hdr";
  const lab = document.createElement("span");
  lab.className = "n-asr-lab";
  lab.textContent = asrT("本地语音转写（Qwen3-ASR）");
  hdr.appendChild(lab);
  const state = document.createElement("span");
  state.className = "n-asr-state" + (node.asrState === "error" || node.asrState === "not_installed" || node.asrState === "no_cuda" ? " err" : "");
  state.textContent =
    node.asrState === "not_installed"
      ? asrT("缺语音后端")
      : node.asrState === "no_cuda"
        ? asrT("无可用显卡")
        : node.asrState === "ok"
          ? asrT("已转写")
          : asrT("待转写");
  hdr.appendChild(state);
  if (node.asrState === "not_installed" || node.asrState === "no_cuda") {
    const inst = document.createElement("button");
    inst.type = "button";
    inst.className = "mini";
    inst.textContent = asrT("一键安装");
    inst.onclick = (ev) => {
      ev.stopPropagation();
      asrOpenInstallDialog({ reason: "node" });
    };
    hdr.appendChild(inst);
  }
  wrap.appendChild(hdr);

  const list = Array.isArray(node.asrTranscripts) ? node.asrTranscripts : [];
  audios.forEach((a) => {
    const row = document.createElement("div");
    row.className = "n-asr-row";
    const t = document.createElement("div");
    t.className = "n-asr-title";
    t.textContent = a.title;
    t.title = a.path;
    row.appendChild(t);
    const hit = list.find(
      (x) => String(x.path || "").toLowerCase() === String(a.path).toLowerCase(),
    );
    const ta = document.createElement("textarea");
    ta.className = "n-text n-asr-text";
    ta.spellcheck = false;
    ta.placeholder = asrT("（点 ▶ 运行时自动转写；也可在此直接改错字）");
    ta.value = hit ? hit.text || "" : "";
    ta.addEventListener("input", () => asrCommitEdit(node, a.path, ta.value));
    ta.addEventListener("click", (ev) => ev.stopPropagation());
    row.appendChild(ta);
    const ops = document.createElement("div");
    ops.className = "bentry-ops";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "mini";
    again.textContent = asrT("重新转写");
    again.onclick = (ev) => {
      ev.stopPropagation();
      asrRetranscribeNode(node, a.path);
    };
    ops.appendChild(again);
    row.appendChild(ops);
    wrap.appendChild(row);
  });

  /* 热词 / 术语：随该节点转写下发（与全局默认热词合并） */
  const hw = document.createElement("div");
  hw.className = "n-asr-hot";
  const hwl = document.createElement("span");
  hwl.textContent = asrT("术语 / 热词");
  const hwi = document.createElement("input");
  hwi.type = "text";
  hwi.className = "n-asr-hot-input";
  hwi.placeholder = asrT("人名、产品名、专业术语，用逗号分隔（提高识别准确率）");
  hwi.value = String(node.asrHotwords || "");
  hwi.addEventListener("change", () => {
    node.asrHotwords = hwi.value;
    try {
      scheduleSave();
    } catch {}
  });
  hwi.addEventListener("click", (ev) => ev.stopPropagation());
  hw.appendChild(hwl);
  hw.appendChild(hwi);
  wrap.appendChild(hw);

  body.appendChild(wrap);
}

/* ============================ 首次连接：安装弹窗 ============================ */
/* 每个画布只自动弹一次（记在画布上，随画布保存；用户拒绝后不再自动弹） */
function asrCanvasAsked() {
  return !!(S.wf && S.wf.asrPrompted);
}
function asrMarkCanvasAsked() {
  if (S.wf && !S.wf.asrPrompted) {
    S.wf.asrPrompted = true;
    try {
      scheduleSave();
    } catch {}
  }
}
/** 连线时调用：把音频接到文字节点 → 需要时弹一次安装窗 */
async function asrMaybePromptOnWire(fromId, toId) {
  if (!asrHasApi()) return;
  const to = typeof nodeById === "function" ? nodeById(toId) : null;
  const from = typeof nodeById === "function" ? nodeById(fromId) : null;
  if (!isAsrConsumerNode(to) || !from) return;
  if (!isAsrAudioSourceKind(from, 0)) return;
  if (asrCanvasAsked()) return;
  const st = await asrStatus(true);
  if (!st) return;
  if (st.installed) return;
  asrMarkCanvasAsked();
  asrOpenInstallDialog({ reason: "wire" });
}

/* ==================== 后台安装（耗时数分钟，允许关窗继续） ====================
   安装脚本动辄几分钟：进度订阅与状态都挂在模块级，点「后台继续安装」把窗关掉也照跑
   （进度在插件卡片上），装完用 toast 收口；窗还开着就地把状态刷成「已安装」。 */
const _asrInst = {
  running: false,
  pct: 0,
  msg: "",
  failed: "", // 上次脚本安装的失败原因（"" = 没失败过；失败后窗里给「交给 AI 安装」入口）
  off: null,
  p: null,
  refs: null, // 当前安装窗的控件引用（关掉即失效，统一用 asrDialogLive 判定）
};

function asrInstallRunning() {
  return !!_asrInst.running;
}

/** 安装窗是否还挂在 #overlay 上（关掉 / 被别的弹窗顶掉都不算） */
function asrDialogLive() {
  const t = document.getElementById("ovTitle");
  const ov = document.getElementById("overlay");
  return !!(
    t &&
    ov &&
    ov.style.display === "flex" &&
    t.textContent === asrT("本地语音转写（Qwen3-ASR）")
  );
}

/** 把模块级安装状态刷到当前安装窗（窗没开着就什么都不做） */
function asrInstallPaint() {
  const refs = _asrInst.refs;
  if (!refs || !asrDialogLive()) return;
  if (refs.prog) refs.prog.style.display = _asrInst.msg ? "block" : "none";
  if (refs.bar) refs.bar.style.width = Math.max(0, Math.min(100, _asrInst.pct || 0)) + "%";
  if (refs.msg) refs.msg.textContent = _asrInst.msg || "";
  if (refs.runBtn) refs.runBtn.disabled = _asrInst.running;
  /* 安装中：这颗按钮就是「后台继续安装」（关掉窗，脚本照跑） */
  if (refs.laterBtn)
    refs.laterBtn.textContent = _asrInst.running ? asrT("后台继续安装") : asrT("稍后");
}

function asrInstallSubscribe() {
  if (_asrInst.off || !window.api || !window.api.onAsrProgress) return;
  _asrInst.off = window.api.onAsrProgress((data) => {
    if (!data) return;
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    _asrInst.pct = pct;
    _asrInst.msg =
      (data.stepLabel || data.step || "") +
      (data.message ? " — " + data.message : "") +
      (pct ? " " + pct + "%" : "");
    asrInstallPaint();
  });
}

/** 跑安装脚本：已经跑着就复用同一趟（不重复起进程），进度一直挂到结束。
    opts.ffmpegOnly = 只补装便携 ffmpeg（不动 venv / 依赖 / 模型）。 */
async function asrInstallRun(opts) {
  const ffmpegOnly = !!(opts && opts.ffmpegOnly);
  if (_asrInst.running) return _asrInst.p;
  _asrInst.running = true;
  _asrInst.pct = 0;
  _asrInst.msg = ffmpegOnly
    ? asrT("正在补装便携 ffmpeg…")
    : asrT("安装中…（可点「后台继续安装」关闭此窗，进度在插件卡片上）");
  asrInstallSubscribe();
  asrInstallPaint();
  _asrInst.p = (async () => {
    let r = null;
    try {
      r = ffmpegOnly
        ? await window.api.asrInstallFfmpeg({ force: true })
        : await window.api.asrInstall({ agent: false });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    _asrInst.running = false;
    if (_asrInst.off) {
      try {
        _asrInst.off();
      } catch {}
      _asrInst.off = null;
    }
    if (r && r.ok) {
      if (ffmpegOnly) {
        _asrInst.msg = asrT("ffmpeg 已就位。");
        _asrInst.failed = "";
        asrInstallPaint();
        toast(asrT("便携 ffmpeg 已就位，音频解码恢复可用"), "ok");
      } else {
        _asrInst.msg = asrT("安装完成，正在静默启动语音后端…");
        asrInstallPaint();
        try {
          await window.api.asrEnsureReady({});
        } catch {}
        asrInvalidateStatus();
        _asrInst.msg = asrT("安装完成。");
        _asrInst.failed = "";
        asrInstallPaint();
        toast(asrT("本地语音后端安装完成，可以开始转写了"), "ok");
      }
    } else {
      _asrInst.failed = (r && r.error) || "unknown";
      _asrInst.msg = (ffmpegOnly ? asrT("ffmpeg 补装失败：") : asrT("安装失败：")) + _asrInst.failed;
      asrInstallPaint();
      toast(
        (ffmpegOnly ? asrT("ffmpeg 补装失败：") : asrT("本地语音后端安装失败：")) + _asrInst.failed,
        "err",
      );
    }
    /* 窗还开着：重开一遍，让状态与按钮回到「已安装 / 失败」形态 */
    if (asrDialogLive() && _asrInst.refs && _asrInst.refs.refresh) _asrInst.refs.refresh();
    /* 这一轮的进度文案到此收口（下次开窗以状态表为准，不残留上一轮的进度条） */
    _asrInst.msg = "";
    _asrInst.pct = 0;
    _asrInst.p = null;
    return r;
  })();
  return _asrInst.p;
}

/** 安装 / 状态 / 设置窗（persistent，不点外部关闭；见 AGENTS.md 对话框纪律） */
async function asrOpenInstallDialog(opts) {
  opts = opts || {};
  if (typeof openOverlay !== "function") return;
  openOverlay(asrT("本地语音转写（Qwen3-ASR）"), { persistent: true });
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) return;
  const st = (await asrStatus(true)) || {};
  const gpuList = (st.gpu && st.gpu.gpus) || [];

  const refs = {
    bar: null,
    msg: null,
    prog: null,
    runBtn: null,
    laterBtn: null,
    refresh: null,
  };

  const intro = document.createElement("div");
  intro.className = "settings-hint";
  intro.textContent = asrT(
    "把音频（音频输入节点 / 素材音频条目 / 语音或音乐产物）接到文字处理节点后，运行时会自动把音频转成文字并注入提示词。模型与后端不随安装包分发，首次使用需下载安装。",
  );
  body.appendChild(intro);

  const table = document.createElement("div");
  table.className = "asr-kv";
  const kv = (k, v, cls) => {
    const r = document.createElement("div");
    r.className = "asr-kv-row" + (cls ? " " + cls : "");
    const a = document.createElement("span");
    a.className = "asr-kv-k";
    a.textContent = k;
    const b = document.createElement("span");
    b.className = "asr-kv-v";
    b.textContent = v;
    b.title = v;
    r.appendChild(a);
    r.appendChild(b);
    table.appendChild(r);
  };
  kv(asrT("模型来源"), "ModelScope · " + (st.model || "Qwen/Qwen3-ASR-0.6B"));
  kv(asrT("分段模型"), st.vadModel || "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch");
  kv(asrT("预计占用"), asrT("模型约 1.9GB + Python 依赖约 3-4GB（CUDA）+ ffmpeg 约 100MB，建议预留 {n}GB 磁盘", { n: st.diskHintGb || 8 }));
  kv(
    asrT("本机显卡"),
    gpuList.length
      ? gpuList.map((g) => (g.name || "") + (g.driver ? " / 驱动 " + g.driver : "")).join("；")
      : asrT("未检测到 NVIDIA 显卡"),
    gpuList.length ? "" : "err",
  );
  kv(asrT("安装目录"), st.installDir || asrT("尚未选择"), st.installDir ? "" : "err");
  const ff = st.ffmpeg || {};
  kv(
    asrT("ffmpeg（音频解码）"),
    ff.ok
      ? (ff.source === "path" ? asrT("系统 PATH") : asrT("便携版（安装目录内）")) + " · " + (ff.path || "")
      : asrT("缺失：无 ffmpeg 时任何音频都无法解码，请点「补装 ffmpeg」"),
    ff.ok ? "" : "err",
  );
  kv(asrT("运行状态"), st.running ? asrT("运行中（静默）") : st.installed ? asrT("已安装 · 未运行") : asrT("未安装"));
  body.appendChild(table);

  if (!st.supported) {
    const warn = document.createElement("div");
    warn.className = "settings-hint asr-warn";
    warn.textContent = asrT(
      "未检测到可用的 NVIDIA 显卡：本功能只装 CUDA 版后端，默认不可用。确有需要可在下方勾选「仍装 CPU 版（很慢）」。",
    );
    body.appendChild(warn);
  }

  /* 进度 */
  const prog = document.createElement("div");
  prog.className = "asr-prog";
  prog.style.display = "none";
  const barWrap = document.createElement("div");
  barWrap.className = "asr-prog-bar";
  const bar = document.createElement("i");
  barWrap.appendChild(bar);
  const msg = document.createElement("div");
  msg.className = "asr-prog-msg";
  prog.appendChild(barWrap);
  prog.appendChild(msg);
  body.appendChild(prog);
  refs.bar = bar;
  refs.msg = msg;
  refs.prog = prog;

  /* 设置区：空闲释放 / 全局热词 / CPU 后门 */
  const setBox = document.createElement("div");
  setBox.className = "asr-settings";
  const idleRow = document.createElement("label");
  idleRow.className = "asr-set-row";
  const idleLab = document.createElement("span");
  idleLab.textContent = asrT("空闲释放（分钟，0 = 不释放）");
  const idle = document.createElement("input");
  idle.type = "number";
  idle.min = "0";
  idle.max = "240";
  idle.value = String(st.idleMinutes == null ? 10 : st.idleMinutes);
  idleRow.appendChild(idleLab);
  idleRow.appendChild(idle);
  setBox.appendChild(idleRow);

  const hwRow = document.createElement("label");
  hwRow.className = "asr-set-row";
  const hwLab = document.createElement("span");
  hwLab.textContent = asrT("全局默认热词（逗号分隔）");
  const hw = document.createElement("input");
  hw.type = "text";
  hw.value = (st.hotwords || []).join("，");
  hwRow.appendChild(hwLab);
  hwRow.appendChild(hw);
  setBox.appendChild(hwRow);

  const cpuRow = document.createElement("label");
  cpuRow.className = "asr-set-row";
  const cpuLab = document.createElement("span");
  cpuLab.textContent = asrT("仍装 CPU 版（很慢，仅在无 N 卡时兜底）");
  const cpu = document.createElement("input");
  cpu.type = "checkbox";
  cpu.checked = !!st.allowCpu;
  cpuRow.appendChild(cpuLab);
  cpuRow.appendChild(cpu);
  setBox.appendChild(cpuRow);
  body.appendChild(setBox);

  const saveSettings = async () => {
    const patch = {
      idleMinutes: Number(idle.value) || 0,
      hotwords: String(hw.value || "")
        .split(/[\n,，、;；]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      allowCpu: !!cpu.checked,
    };
    await window.api.asrSetConfig(patch);
    asrInvalidateStatus();
    toast(asrT("已保存语音转写设置"), "ok");
  };

  /* 底部按钮 */
  const mkBtn = (label, fn, opts2) => {
    const b = document.createElement("button");
    b.className = (opts2 && opts2.cls) || "mini";
    b.textContent = label;
    b.disabled = !!(opts2 && opts2.disabled);
    b.onclick = fn;
    foot.appendChild(b);
    return b;
  };

  refs.refresh = () => asrOpenInstallDialog(opts);

  mkBtn(asrT("选择安装目录"), async () => {
    const r = await window.api.asrPickInstallDir();
    if (r && r.ok) {
      asrInvalidateStatus();
      refs.refresh();
    } else if (r && r.error) {
      toast(asrT("该目录不可用：") + r.error, "err");
    }
  });
  mkBtn(asrT("选择已有模型目录"), async () => {
    const r = await window.api.asrPickModelDir();
    if (r && r.ok) {
      asrInvalidateStatus();
      asrOpenInstallDialog(opts);
    }
  });
  const showLog = async () => {
    const tail = await window.api.asrConsoleTail(40000);
    const pre = document.createElement("pre");
    pre.className = "asr-log";
    pre.textContent = tail || asrT("（暂无日志）");
    body.appendChild(pre);
    pre.scrollIntoView({ block: "nearest" });
  };

  refs.runBtn = mkBtn(
    st.installed ? asrT("重新安装 / 补充安装") : asrT("下载并安装（脚本）"),
    async () => {
      saveSettings();
      if (!st.installDir) {
        const r = await window.api.asrPickInstallDir();
        if (!r || !r.ok) return;
      }
      /* 安装动辄几分钟：交给模块级的后台安装，关窗照跑（见 asrInstallRun） */
      await asrInstallRun({});
    },
    { cls: "mini primary" },
  );
  /* 缺便携 ffmpeg = 任何音频都解不开：单独一条快速补装通道（-FfmpegOnly，不动 venv / 模型） */
  if (st.installed && st.ffmpeg && !st.ffmpeg.ok) {
    mkBtn(asrT("补装 ffmpeg"), () => asrInstallRun({ ffmpegOnly: true }));
  }
  if (st.installed) mkBtn(asrT("查看安装日志"), showLog);
  if (window.api.asrOpen) {
    mkBtn(asrT("打开控制台"), async () => {
      const r = await window.api.asrOpen();
      if (!r || !r.ok) toast(asrT("打开失败：") + ((r && r.error) || asrT("未知错误")), "err");
      else closeOverlay();
    });
  }
  mkBtn(asrT("保存设置"), () => saveSettings());
  /* 脚本安装 / 补装失败过：给「交给 AI 安装 / 自我修复」入口（Agent 会按 skill 修） */
  if (_asrInst.failed) {
    mkBtn(asrT("交给 AI 安装 / 自我修复"), async () => {
      msg.textContent = asrT("Agent 正在安装…（可关闭此窗，进度在插件卡片上）");
      prog.style.display = "block";
      await window.api.asrAgentRecoverInstall({ error: _asrInst.failed });
      _asrInst.failed = "";
      asrInvalidateStatus();
      if (asrDialogLive()) refs.refresh();
    });
  }
  refs.laterBtn = mkBtn(asrT("稍后"), () => {
    if (_asrInst.running) toast(asrT("安装已在后台继续，可在「插件」卡片查看进度"), "ok");
    closeOverlay();
  });
  /* 重开窗时把仍在跑的安装状态接回来（进度条 / 按钮文案 / 运行状态） */
  _asrInst.refs = refs;
  asrInstallPaint();
}
