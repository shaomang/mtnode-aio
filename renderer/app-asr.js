"use strict";
/* ============================================================================
 * 画布节点级语音转写（renderer/app-asr.js）
 * ----------------------------------------------------------------------------
 * 需求（本轮改口径）：转写不再挂在文字处理节点上，而是**音频节点**自己的能力：
 *   · 音频输入节点 / 视频输入节点（文件节点载入音频 / 视频后的那张节点）的预览下方
 *     多一枚「转录」按钮 —— 点一下就地把该文件转成文字（可编辑、可重新转录）；
 *   · 文字处理节点（proc_text 普通与智能模式、agent_task）**不再自己转写**：它们只在
 *     点 ▶ 运行时，去上游音频 / 视频节点取已备好的转写文本，没有（或音频文件已变、
 *     且文本不是用户手改的）就当场替那张音频节点转一次，再拿它的文字往下走。
 *
 * 识别引擎：**官方本地 SenseVoice**（跑在 dsh 运行时里，与状态栏那枚话筒、应用窗口的
 * appHost.asr* 同一条通道 —— 全应用只有这一份语音模型与缓存，不会重复下载）。
 * 本文件只做节点侧的那几件事：
 *   · 找「这个节点的音频文件」（audio / video 输入节点的 mediaAsset）；
 *   · 转写结果写在**音频节点自己身上**（node.asrTranscripts，随画布持久化）+ 主进程按
 *     音频路径缓存（speech-store.js，命中即秒回）；
 *   · 新鲜度：存指纹（路径 + 大小 + 修改时间）—— 文件变了就重转；用户手改过（edited）
 *     的文本绝不覆盖，只给一句提醒；
 *   · 运行前闸门 asrEnsureForRun（文字节点在 app-nodes.js 里调）与对外取文接口
 *     asrTextItemsOf（app.js 的 allTextItems / resolveRefs 调）。
 *
 * 与「图像 → 视觉模型」的分工一致：音频只被文字节点消费，转写产物是纯文本；
 * 音频节点自己的输出端子口径不变（照旧给该文件的 file:/// URL，视频节点仍是视频 URL）。
 *
 * 不再有的东西（随旧口径移除）：文字节点上的「本地语音转写」区块、asrPrepareForRun、
 * asrTaskAppendText（智能节点任务描述追加）与 node.asrTranscripts 的消费方假设。
 * 更早的 Qwen3-ASR 那套（Python 后端 / venv / CUDA / ffmpeg / 插件控制台 / 热词表）
 * 早已移除，SenseVoice 的官方调用只收 audio + language。
 * ==========================================================================*/

/** 现况缓存：同一帧里节点重绘可能问好几次，只留最近一次 */
let _asrSt = null;
let _asrStAt = 0;
/** 节点上转写文本的写缓存防抖：nodeId + "\0" + path(小写) → timer */
const _asrEditTimers = new Map();
/** 在飞的转写：key 同上 → Promise（同一音频不被同时转两遍） */
const _asrBusy = new Map();

/* 语音运行时是**按需冷起**的（实测约 1~2 秒；首次还要加载 ONNX + VAD）：这期间
   speech 的提供者名单是空的。名单空 = **引擎还在启动**，不是「不可用」——
   状态栏那枚话筒一直有这层退避重试（app-voice.js 的 READY_TRIES × READY_RETRY_MS），
   节点这条也按同一口径重试：4 次 × 400ms；**只等名单**（模型没就绪另有下载流程，
   不在这里等）。 */
const ASR_READY_TRIES = 4;
const ASR_READY_RETRY_MS = 400;

function asrT(s, vars) {
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(s, vars) : s;
}
function asrHasApi() {
  return !!(typeof window !== "undefined" && window.api && window.api.dshSpeech);
}

/* ==================== 谁有音频：音频 / 视频输入节点 ==================== */
/** 这个节点自身是否带音频文件（音频输入节点、视频输入节点：视频的音轨也是音频） */
function isAsrMediaNode(node) {
  return !!(node && (node.kind === "input_audio" || node.kind === "input_video"));
}
/** 该节点当前绑定的媒体文件绝对路径（未选文件 → 空串） */
function asrMediaPathOf(node) {
  if (!isAsrMediaNode(node)) return "";
  return String(node.mediaAsset || "").trim();
}
/** 媒体类型：audio / video（视频节点的转写同样当文本给下游） */
function asrMediaKindOf(node) {
  return node && node.kind === "input_video" ? "video" : "audio";
}
/** 「音频节点」的显示名（转写块标题与提示词块标题都用它） */
function asrSourceLabel(node) {
  return (
    String((node && (node.sourceName || node.title)) || "").trim() ||
    (asrMediaKindOf(node) === "video" ? asrT("视频") : asrT("音频"))
  );
}

/** 该节点的转写条目（一条媒体 = 一条转写；旧存档里可能不止一条） */
function asrTranscriptOf(node, path) {
  const key = String(path || "").toLowerCase();
  if (!key) return null;
  const list = (node && node.asrTranscripts) || [];
  for (const t of list) {
    if (String(t && t.path ? t.path : "").toLowerCase() === key && t.text != null) return t;
  }
  return null;
}
/** 节点上「当前这条媒体」的转写文本（下游取文与界面共用） */
function asrTranscriptTextOf(node) {
  const p = asrMediaPathOf(node);
  if (!p) return "";
  const hit = asrTranscriptOf(node, p);
  return hit ? String(hit.text || "") : "";
}
/** 媒体文件指纹（路径 + 大小 + 修改时间）：拿不到大小 / 时间（文件没了）时只认路径 */
async function asrStampOf(path) {
  const out = { path: String(path || ""), size: 0, mtime: 0 };
  if (!out.path) return out;
  try {
    if (window.api && typeof window.api.fileStat === "function") {
      const st = await window.api.fileStat(out.path);
      if (st) {
        out.size = Number(st.bytes || st.size) || 0;
        out.mtime = Math.floor(Number(st.mtimeMs || st.mtime) || 0);
      }
    }
  } catch {}
  return out;
}
/** 指纹是否一致（大小与时间都对得上才算「文件没变」） */
function asrStampFresh(a, b) {
  if (!a || !b) return false;
  if (String(a.path || "").toLowerCase() !== String(b.path || "").toLowerCase()) return false;
  const an = Number(a.size) || 0;
  const bn = Number(b.size) || 0;
  const am = Number(a.mtime) || 0;
  const bm = Number(b.mtime) || 0;
  /* 两边都没量到（无 fileStat / 旧存档没存）：只认路径，别把「没数据」当成「变了」 */
  if (!an && !bn && !am && !bm) return true;
  return an === bn && am === bm;
}
/** 转写是否新鲜：有文本 + 指纹一致 */
async function asrIsFresh(node) {
  const p = asrMediaPathOf(node);
  if (!p) return false;
  const rec = asrTranscriptOf(node, p);
  if (!rec || !String(rec.text || "").trim()) return false;
  return asrStampFresh(rec.stamp, await asrStampOf(p));
}

/* ==================== 引擎现况（带 TTL） ==================== */
async function asrStatus(force) {
  if (!asrHasApi() || typeof spStatus !== "function") return null;
  if (!force && _asrSt && Date.now() - _asrStAt < 3000) return _asrSt;
  const st = await spStatus(force);
  _asrSt = st || null;
  _asrStAt = Date.now();
  return _asrSt;
}
function asrInvalidateStatus() {
  _asrStAt = 0;
}
/** 引擎相位（ready / downloading / failed / unprepared） */
function asrPhase(st) {
  if (typeof spPhaseOf !== "function") return { ready: false, available: false, phase: "unprepared" };
  return spPhaseOf(st);
}
/** 失败 → 一句人话（引擎那侧的词表在 app-speech.js，这里只补节点侧的语境） */
function asrErrText(r) {
  if (typeof spErrText === "function") return spErrText(r || {});
  return (r && (r.message || r.error)) || asrT("语音识别没能完成（稍后再试）");
}
/** 冷起窗口里会看到的相位（实测：+1.9s 名单出现且 phase=checking、+2.4s ready）：
 *  这段时间只该等 —— 判成「模型没就绪」会弹下载窗、把一次正常的首次转写吓回去。 */
const ASR_STARTING_PHASES = /^(checking|loading|waking)$/;
/** 名单为空 = 语音运行时还在冷起（实测约 1~2 秒），不是「服务不可用」；
 *  名单已出但还在 checking / loading / waking 也在同一个窗口里。
 *  「语音通道未就绪（运行时刚起来时请稍等一两秒再试）」这一类明确报错同样是这个窗口：
 *  网关刚把运行时拉起来，插件那条 socket 还没登记 —— 都值得退避重试。
 *  只有真配置错（缺工作目录之类）与真下载（phase=downloading）才当场如实上报，不在这儿空等。 */
function asrStarting(st) {
  if (typeof spPhaseOf !== "function") return false;
  const p = spPhaseOf(st);
  if (p.starting) return true;
  if (ASR_STARTING_PHASES.test(String(p.phase || ""))) return true;
  return /未就绪|通道|not\s*ready|starting|启动/i.test(String(p.error || ""));
}
function asrSleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}
/** 拿一次「已起步」的引擎现况：名单空（冷起窗口）就按 ASR_READY_TRIES 退避重试。
 *  **每一轮都现读**（force）：3 秒 TTL 里那份可能是下载 / 冷起期间留下的旧值 ——
 *  用户刚把模型下完就点「转录」，照着旧值会继续被判「未就绪」（本函数只在真转写前调）。
 *  **只等名单**：模型没就绪是另一条流程（下载 + 下一轮重跑），不在这里空等。
 *  返回 { st, starting }：starting=true = 重试完仍是空名单（引擎还在起，不是坏）。 */
async function asrStatusReady() {
  let st = null;
  for (let i = 0; i < ASR_READY_TRIES; i++) {
    st = await asrStatus(true);
    if (!st) return { st: null, starting: false };
    if (!asrStarting(st)) return { st: st, starting: false };
    if (i < ASR_READY_TRIES - 1) await asrSleep(ASR_READY_RETRY_MS);
  }
  return { st: st, starting: true };
}
/** 引擎门：可用 / 模型就绪才放行；缺模型顺手把下载跑起来（约 239MB，全应用只此一份） */
async function asrEngineGate(node) {
  const got = await asrStatusReady();
  const st = got.st;
  if (!st) {
    return {
      ok: false,
      error: "no_api",
      message: asrT("语音识别服务不可用（本机 dsh 运行时的语音能力没起来）"),
    };
  }
  const ph = asrPhase(st);
  if (got.starting || !ph.available) {
    /* 名单为空 = 语音运行时还在冷起（首次约 1~2 秒）：重试完仍是空的才当作「还在启动」，
       说清「等一下再点」而不是把这一次判成服务坏掉。 */
    if (got.starting) {
      if (node) node.asrState = "starting";
      return {
        ok: false,
        error: "starting",
        message: asrT("语音服务正在启动（首次约一两秒）：稍等一下再试"),
      };
    }
    if (node) node.asrState = "unavailable";
    /* 通道明确报错时把原因翻成人话（缺工作目录 / 网关没起来…）：一律说「语音能力没起来」
       会让用户没处下手。 */
    const why = ph.error && typeof spErrText === "function" ? spErrText({ error: ph.error }) : "";
    return {
      ok: false,
      error: "unavailable",
      message: why || asrT("语音识别服务不可用（本机 dsh 运行时的语音能力没起来）"),
    };
  }
  if (!ph.ready) {
    if (node) node.asrState = ph.failed ? "failed" : "downloading";
    const msg = typeof spPhaseText === "function" ? spPhaseText(st) : asrT("语音模型尚未下载");
    /* 没就绪就把下载跑起来（幂等；下载完下一轮即可转写），但不硬等 —— 本次明确拦下 */
    if (typeof spEnsureReady === "function") {
      try {
        spEnsureReady();
      } catch {}
      try {
        asrOpenModelDialog({ reason: "run" });
      } catch {}
    }
    return {
      ok: false,
      error: ph.failed ? "prepare_failed" : "unprepared",
      message: msg,
    };
  }
  if (node) node.error = null;
  return { ok: true, st: st };
}

/* ==================== 转写主流程 ==================== */
/** 节点上的进度文案（长音频逐句跑，界面要看得见第几句） */
function asrProgressText(info, total) {
  const n = Math.max(1, Number(total) || 1);
  const i = Math.min(n, Math.max(1, Number((info && info.index) || 0) + 1));
  return n > 1 ? asrT("转录中…（第 {i}/{n} 句）", { i: i, n: n }) : asrT("转写中…");
}
/** 一次转写：写回节点字段（含指纹）+ 主进程缓存。force=true 时忽略已有文本（用户点重转）。 */
async function asrTranscribeNode(node, opts) {
  const o = opts || {};
  if (!isAsrMediaNode(node)) return { ok: false, error: "not_media_node" };
  const path = asrMediaPathOf(node);
  if (!path) {
    node.asrState = "error";
    node.error = asrT("先选择音频文件，再点「转录」");
    return { ok: false, error: "no_path", message: node.error };
  }
  const key = String(node.id || "") + "\u0000" + path.toLowerCase();
  if (_asrBusy.has(key)) return _asrBusy.get(key);
  const run = (async () => {
    /* 每次真正要转写都现读一遍引擎现况：3 秒 TTL 的那份现况可能是下载 / 冷起期间留下的旧值，
       照着它做决定会出现「明明已经就绪却仍被判没法转」。 */
    asrInvalidateStatus();
    const gate = await asrEngineGate(node);
    if (!gate.ok) {
      node.error = gate.message;
      try {
        toast(gate.message, /failed|unavailable/.test(String(gate.error)) ? "warn" : "info");
      } catch {}
      return gate;
    }
    node.asrState = "running";
    node.error = null;
    try {
      renderCanvas();
    } catch {}
    let r = null;
    try {
      r = await spTranscribeFile(path, {
        language: String(node.asrLanguage || "auto"),
        force: !!o.force,
        onProgress: (info) => {
          try {
            node.asrProgress = info || null;
            node.asrState = "running";
            renderCanvas();
          } catch {}
        },
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    node.asrProgress = null;
    if (!r || !r.ok) {
      node.asrState = "error";
      node.error = (r && r.message) || asrErrText(r);
      try {
        toast(node.error, "err");
      } catch {}
      try {
        renderCanvas();
      } catch {}
      return { ok: false, error: (r && r.error) || "asr_failed", message: node.error };
    }
    const stamp = await asrStampOf(path);
    const list = Array.isArray(node.asrTranscripts)
      ? node.asrTranscripts.filter(
          (t) =>
            String(t && t.path ? t.path : "").toLowerCase() !== path.toLowerCase(),
        )
      : [];
    list.push({
      path: path,
      title: asrSourceLabel(node),
      text: String(r.text || ""),
      edited: false,
      cached: !!r.cached,
      segments: Number(r.segments) || 0,
      duration_sec: Number(r.durationSec) || Number(r.duration_sec) || 0,
      stamp: stamp,
      at: Date.now(),
    });
    node.asrTranscripts = list;
    node.asrState = "ok";
    node.error = null;
    try {
      scheduleSave();
    } catch {}
    try {
      renderCanvas();
    } catch {}
    return { ok: true, text: String(r.text || ""), cached: !!r.cached, segments: Number(r.segments) || 0 };
  })();
  _asrBusy.set(key, run);
  try {
    return await run;
  } finally {
    _asrBusy.delete(key);
  }
}

/** 音频节点上的「转录 / 重新转录」按钮入口 */
async function asrTranscribeFromNode(node) {
  const r = await asrTranscribeNode(node, { force: true });
  if (r && r.ok) {
    try {
      toast(asrT("已转录"), "ok");
    } catch {}
  } else if (r && r.message) {
    try {
      toast(r.message, "warn");
    } catch {}
  }
  return r;
}

/* ==================== 运行前闸门（文字节点点 ▶ 时调） ==================== */
function asrNodeById(id) {
  try {
    return typeof nodeById === "function" ? nodeById(id) : null;
  } catch {
    return null;
  }
}
/** 指向这个文字节点的上游音频 / 视频节点（同一个源只算一次，按连线顺序） */
function asrUpstreamMediaNodes(node) {
  const out = [];
  const seen = new Set();
  if (!node || typeof wiresTo !== "function") return out;
  const push = (n) => {
    if (!n || !isAsrMediaNode(n) || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };
  for (const w of wiresTo(node.id)) {
    if (!w || w.rel) continue;
    const src = asrNodeById(w.from);
    if (!src) continue;
    /* 超级节点壳 / 素材节点这类中转：src 不是音频节点就按「这个源的叶子」再摊一层 */
    if (isAsrMediaNode(src)) {
      push(src);
      continue;
    }
    if (typeof refLeafSourcesForWire === "function") {
      try {
        for (const leaf of refLeafSourcesForWire(w, node)) push(leaf);
      } catch {}
    }
  }
  return out;
}
/**
 * 文字节点运行前的音频闸门（app-nodes.js 在执行上游补跑之后、本节点起跑之前调）：
 *   · 没有接音频 / 视频节点 → 直接放行（行为逐字不变）；
 *   · 逐个上游音频节点：已有新鲜转写 → 直接用，**不重转**（转一次多处复用）；
 *   · 没有转写 / 音频文件变了（指纹不一致）→ 当场替它转一次，写回那张音频节点；
 *   · 文本是用户手改过的（edited）但文件变了 → 不覆盖，只提醒，照旧用用户那份；
 *   · 引擎不可用 / 模型没下载 / 转写失败 → 拦下本轮（不静默把音频当没输入）。
 * 返回 { ok:false, error, message } 时调用方必须中止本轮。
 */
async function asrEnsureForRun(node) {
  const srcs = asrUpstreamMediaNodes(node);
  if (!srcs.length) return { ok: true };
  for (const src of srcs) {
    const path = asrMediaPathOf(src);
    if (!path) continue; /* 音频节点还没选文件：下游按「无输入」处理，不拦 */
    const rec = asrTranscriptOf(src, path);
    const fresh = await asrStampFresh(rec && rec.stamp, await asrStampOf(path));
    if (rec && String(rec.text || "").trim()) {
      if (fresh) continue;
      if (rec.edited) {
        /* 用户手改过的文本绝不覆盖：只提醒，照旧用他那一份 */
        try {
          toast(asrT("音频文件已变动，但该节点的转录是你手改过的：未自动重转（想刷新请在音频节点上点「重新转录」）"), "warn");
        } catch {}
        continue;
      }
    }
    const r = await asrTranscribeNode(src, { force: true });
    if (!r || !r.ok) {
      const msg = (r && r.message) || asrErrText(r);
      node.asrState = src.asrState || "error";
      node.error = msg;
      if (r && (r.error === "unprepared" || r.error === "prepare_failed" || r.error === "starting"))
        node.error = asrT("转录还没完成：") + msg;
      return { ok: false, error: (r && r.error) || "asr_failed", message: node.error };
    }
  }
  return { ok: true };
}

/* ==================== 取文：下游文字节点读音频节点的转写 ==================== */
function asrBlockTitle(node) {
  const label = asrSourceLabel(node);
  return asrT("音频转写") + (label ? " · " + label : "");
}
/** allTextItems / resolveRefs 钩子：这个来源是音频 / 视频节点且有转写 → 给出背景块 */
function asrTextItemsOf(src, consumer, portIdx) {
  const one = asrTranscriptBlockOf(consumer, src, portIdx);
  return one ? [one] : null;
}
/** 单个背景块（没转写 → null，调用方走原有口径） */
function asrTranscriptBlockOf(consumer, src) {
  if (!consumer || !src || !isAsrMediaNode(src)) return null;
  const text = asrTranscriptTextOf(src);
  if (!text.trim()) return null;
  return { title: asrBlockTitle(src), text: text };
}
/** 同上，签名沿用旧调用点的 (consumer, src, portIdx) */
function asrTranscriptBlockFor(consumer, src) {
  return asrTranscriptBlockOf(consumer, src);
}
/** 这个文字节点接线上所有音频 / 视频节点的转写块（会话模式补进 input 用） */
function asrTextBlocksFor(node) {
  const out = [];
  for (const src of asrUpstreamMediaNodes(node)) {
    const one = asrTranscriptBlockOf(node, src);
    if (one) out.push(one);
  }
  return out;
}

/* ==================== 旧字段清理（本轮口径切换） ==================== */
/**
 * 本轮起转写归音频节点所有：文字节点上的 node.asrTranscripts / node.asrState 是旧口径
 * 留下的字段，打开存档 / 切画布时**默默删掉**（不再读、也不留残渣）。
 * 返回是否有改动（true 时调用方落盘）。
 */
function asrPurgeLegacyTranscripts(wf) {
  let hit = false;
  for (const n of (wf && wf.nodes) || []) {
    if (!n || (n.kind !== "proc_text" && n.kind !== "agent_task")) continue;
    if (n.asrTranscripts !== undefined) {
      delete n.asrTranscripts;
      hit = true;
    }
    if (n.asrState !== undefined) {
      delete n.asrState;
      hit = true;
    }
  }
  return hit;
}

/* ==================== 节点上的转写文本（编辑 / 重新转录） ==================== */
/** 编辑防抖写缓存：停手 400ms 后写一次（一处编辑全画布生效） */
function asrCommitEdit(node, path, text) {
  const key = String(node && node.id ? node.id : "") + "\u0000" + String(path || "").toLowerCase();
  const rec = asrTranscriptOf(node, path);
  if (rec) {
    rec.text = String(text || "");
    rec.edited = true;
  }
  if (_asrEditTimers.has(key)) clearTimeout(_asrEditTimers.get(key));
  _asrEditTimers.set(
    key,
    setTimeout(() => {
      _asrEditTimers.delete(key);
      try {
        if (typeof spRememberEdited === "function")
          spRememberEdited(path, text, (node && node.asrLanguage) || "auto");
      } catch {}
    }, 400),
  );
  try {
    scheduleSave();
  } catch {}
}
/** 清掉这个节点的转写（文件与缓存都不动，只清节点上那份文字） */
function asrClearNodeTranscript(node) {
  const path = asrMediaPathOf(node);
  if (!path) return;
  if (Array.isArray(node.asrTranscripts)) {
    node.asrTranscripts = node.asrTranscripts.filter(
      (t) => String(t && t.path ? t.path : "").toLowerCase() !== path.toLowerCase(),
    );
  }
  node.asrState = "";
  node.error = null;
  try {
    if (typeof spCacheClear === "function") spCacheClear(path);
  } catch {}
  try {
    scheduleSave();
    renderCanvas();
  } catch {}
}

/** 转录文本区的展开 / 收起（存节点字段，随画布持久化） */
function asrToggleNodePanel(node) {
  if (!node) return;
  node.asrOpen = !node.asrOpen;
  try {
    scheduleSave();
    renderCanvas();
  } catch {}
}

/**
 * 音频 / 视频节点 body 上的转写块（由 app-canvas.js 在操作行之后调用）：
 *   · 没选文件：只给一枚禁用的「转录」按钮，不占别的版面；
 *   · 有文件：操作行旁那枚按钮展开后，这里出现可编辑文本区 + 「重新转录 / 清空」。
 */
function asrAppendNodeBody(node, body) {
  if (!body || !isAsrMediaNode(node)) return;
  const p = asrMediaPathOf(node);
  const rec = p ? asrTranscriptOf(node, p) : null;
  const wrap = document.createElement("div");
  wrap.className = "n-asr";
  wrap.addEventListener("click", (ev) => ev.stopPropagation());

  const hdr = document.createElement("div");
  hdr.className = "n-asr-hdr";
  const lab = document.createElement("span");
  lab.className = "n-asr-lab";
  lab.textContent = asrT("本地语音转写（SenseVoice）");
  hdr.appendChild(lab);
  const state = document.createElement("span");
  const bad =
    node.asrState === "error" || node.asrState === "unavailable" || node.asrState === "failed";
  state.className = "n-asr-state" + (bad ? " err" : "");
  const prog = node.asrProgress && node.asrState === "running" ? node.asrProgress : null;
  state.textContent =
    node.asrState === "running"
      ? asrProgressText(prog, prog && prog.total)
      : node.asrState === "ok"
        ? asrT("已转录")
        : node.asrState === "downloading"
          ? asrT("模型未就绪")
          : node.asrState === "starting"
            ? asrT("语音服务启动中")
            : node.asrState === "unavailable" || node.asrState === "failed"
              ? asrT("语音服务不可用")
              : rec && String(rec.text || "").trim()
                ? asrT("已转录")
                : asrT("待转录");
  hdr.appendChild(state);
  if (
    node.asrState === "downloading" ||
    node.asrState === "starting" ||
    node.asrState === "unavailable" ||
    node.asrState === "failed"
  ) {
    const inst = document.createElement("button");
    inst.type = "button";
    inst.className = "mini";
    inst.textContent = asrT("语音模型…");
    inst.onclick = (ev) => {
      ev.stopPropagation();
      asrOpenModelDialog({ reason: "node" });
    };
    hdr.appendChild(inst);
  }
  wrap.appendChild(hdr);

  if (!node.asrOpen) {
    if (node.error) {
      const e = document.createElement("div");
      e.className = "n-asr-err";
      e.textContent = String(node.error);
      wrap.appendChild(e);
    }
    body.appendChild(wrap);
    return;
  }

  const row = document.createElement("div");
  row.className = "n-asr-row";
  const ta = document.createElement("textarea");
  ta.className = "n-text n-asr-text";
  ta.spellcheck = false;
  ta.placeholder = p
    ? asrT("（点「转录」把这段音频转成文字；也可以在这里直接改错字）")
    : asrT("（先选择音频文件，再点「转录」）");
  ta.value = rec ? String(rec.text || "") : "";
  ta.disabled = !p;
  ta.addEventListener("input", () => {
    if (p) asrCommitEdit(node, p, ta.value);
  });
  ta.addEventListener("click", (ev) => ev.stopPropagation());
  row.appendChild(ta);
  wrap.appendChild(row);

  if (node.error) {
    const e = document.createElement("div");
    e.className = "n-asr-err";
    e.textContent = String(node.error);
    wrap.appendChild(e);
  }

  const ops = document.createElement("div");
  ops.className = "bentry-ops n-asr-ops";
  const again = document.createElement("button");
  again.type = "button";
  again.className = "mini";
  again.disabled = !p || node.asrState === "running";
  again.textContent = p && rec ? asrT("重新转录") : asrT("转录");
  again.onclick = (ev) => {
    ev.stopPropagation();
    asrTranscribeFromNode(node);
  };
  ops.appendChild(again);
  const clr = document.createElement("button");
  clr.type = "button";
  clr.className = "mini";
  clr.disabled = !p || !(rec && String(rec.text || "").trim());
  clr.textContent = asrT("清空转录");
  clr.onclick = (ev) => {
    ev.stopPropagation();
    asrClearNodeTranscript(node);
  };
  ops.appendChild(clr);
  wrap.appendChild(ops);
  body.appendChild(wrap);
}

/**
 * 操作行里那枚「转录」按钮（app-canvas.js 把它 append 进 .n-av-ops）：
 * 没选文件时禁用；点一下展开 / 收起本节点的转录文本区，并在没有转写时就地转一次。
 */
function asrOpsButton(node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini n-asr-btn";
  b.textContent = asrT("转录");
  const p = asrMediaPathOf(node);
  b.disabled = !p;
  b.title = p ? asrT("把这段音频转成文字（本机 SenseVoice 模型，与麦克风听写同一个）") : asrT("先选择音频文件");
  b.onclick = (ev) => {
    ev.stopPropagation();
    const path = asrMediaPathOf(node);
    if (!path) return;
    const rec = asrTranscriptOf(node, path);
    const dark = !node.asrOpen;
    node.asrOpen = true;
    try {
      renderCanvas();
    } catch {}
    if (dark && !(rec && String(rec.text || "").trim())) asrTranscribeFromNode(node);
    else {
      try {
        scheduleSave();
      } catch {}
    }
  };
  return b;
}

/* ==================== 语音模型：下载 / 检查 / 语言（持久窗） ====================
   与从前那套「Python 后端安装」的差别：这里没有安装目录、没有 venv / CUDA / ffmpeg，
   只有一件事 —— 把官方 SenseVoice 权重（约 239MB）下到本机（进度由 dsh 运行时推）。
   全应用只有这一份模型与缓存：状态栏话筒、应用窗口听写、画布节点转写共用它。 */
let _asrModelOff = null;
/** 窗是否还挂着（关掉 / 被别的弹窗顶掉都不算） */
function asrDialogLive() {
  const t = document.getElementById("ovTitle");
  const ov = document.getElementById("overlay");
  return !!(
    t &&
    ov &&
    ov.style.display === "flex" &&
    t.textContent === asrT("本地语音识别（SenseVoice）")
  );
}
/** 订阅下载进度（模块级，窗关掉也不丢；重开窗时状态现读一次即可） */
function asrModelSubscribe(refs) {
  if (_asrModelOff || !window.api || !window.api.onSpeechState) return;
  _asrModelOff = window.api.onSpeechState(() => {
    asrInvalidateStatus();
    if (!asrDialogLive()) return;
    if (refs && refs.paint) refs.paint();
  });
}
/** 打开/刷新「语音模型」窗（persistent，不点外部关闭；见 AGENTS.md 对话框纪律） */
async function asrOpenModelDialog() {
  if (typeof openOverlay !== "function") return;
  openOverlay(asrT("本地语音识别（SenseVoice）"), { persistent: true });
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) return;
  body.innerHTML = "";
  foot.innerHTML = "";

  const refs = { paint: null };
  const box = document.createElement("div");
  box.className = "asr-set";
  const row = (label, val) => {
    const r = document.createElement("div");
    r.className = "asr-set-row";
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "asr-set-val";
    v.textContent = val;
    r.appendChild(l);
    r.appendChild(v);
    box.appendChild(r);
    return v;
  };
  const vState = row(asrT("状态"), asrT("检查中…"));
  row(asrT("预计占用"), asrT("识别模型约 239MB（首次使用自动下载到本机，离线可用）"));
  const vLang = row(asrT("识别语言"), asrT("自动"));
  row(
    asrT("使用范围"),
    asrT("全应用同一份：状态栏话筒听写、应用窗口听写、画布音频节点转录都用它，只下载一次"),
  );
  body.appendChild(box);

  const dlRow = document.createElement("label");
  dlRow.className = "asr-set-row";
  const dlLab = document.createElement("span");
  dlLab.textContent = asrT("下载源");
  const dlSel = document.createElement("select");
  [
    ["", asrT("自动（按官方顺序探测）")],
    ["modelscope", "ModelScope"],
    ["huggingface", "HuggingFace"],
  ].forEach((o) => {
    const op = document.createElement("option");
    op.value = o[0];
    op.textContent = o[1];
    dlSel.appendChild(op);
  });
  dlRow.appendChild(dlLab);
  dlRow.appendChild(dlSel);
  body.appendChild(dlRow);

  const mkBtn = (label, fn, cls) => {
    const b = document.createElement("button");
    b.className = cls || "mini";
    b.textContent = label;
    b.onclick = fn;
    foot.appendChild(b);
    return b;
  };

  const refresh = async () => {
    const st = await asrStatus(true);
    const ph = asrPhase(st);
    vState.textContent = typeof spPhaseText === "function" ? spPhaseText(st) : asrT("语音状态未知");
    vLang.textContent = (st && st.selection && st.selection.language) || asrT("自动");
    runBtn.textContent = ph.ready
      ? asrT("重新检查")
      : ph.downloading
        ? asrT("下载中…")
        : asrT("下载语音模型");
    runBtn.disabled = !!ph.downloading;
    dlSel.disabled = !!ph.downloading;
  };
  refs.paint = () => {
    if (asrDialogLive()) void refresh();
  };
  asrModelSubscribe(refs);

  const runBtn = mkBtn(asrT("下载语音模型"), async () => {
    runBtn.disabled = true;
    vState.textContent = asrT("正在准备语音模型…");
    if (typeof spEnsureReady === "function") await spEnsureReady();
    await refresh();
  });
  mkBtn(asrT("关闭"), () => {
    if (typeof closeOverlay === "function") closeOverlay();
  });

  await refresh();
}

/* 兼容旧调用点（节点区块与插件卡片原先叫「安装」）：一律落到新的语音模型窗 */
function asrOpenInstallDialog() {
  return asrOpenModelDialog();
}
