"use strict";
/* ============ 插件报错 → 看得见的一条会话在修（自动修复） ============
 * 插件（本地后端宿主 music3 / h3 / tts / llama / asr / remotion 与窗口插件）运行期报错时，
 * 不再只在插件窗里藏一个看不见的 dsh 任务：主进程把错误推给渲染层，这里弹一只**错误报告窗**
 * （错误码 / 错误正文 / 可折叠日志尾部 / 出问题的节点与画布），用户点「🤖 自动修复」→
 * 在左侧栏新建一条**看得见的会话**（标题「自动修复 · <插件名>」，工作区 = 该插件 INSTALL_DIR，
 * 开启「与画布无关」省 token），把修复提示词发进去。用户可随时看它在改什么、终止它、追问它。
 *
 * IPC 契约（preload.js 白名单桥，主进程侧 handler / 推送方见 main.js 与各插件宿主）：
 *   window.api.onPluginRepairError(cb)      ← 主进程 send('pluginRepair:error', payload)
 *     payload（字段一律可选，缺什么就不显示什么、不进提示词）：
 *       { pluginId | plugin, pluginName | name, kind, installDir | dir, scaffoldRef | scaffold,
 *         skill, code | errorCode, message | error | text, log | logTail | consoleTail,
 *         focus | failedFocus, nodeId, nodeTitle, nodeKind, workflowId, workflowName,
 *         marker, resultFile, repairToken | token, repairable, why, at }
 *     repairable / why 由主进程的 judgeRepairability 定（唯一真源）：repairable=false 时
 *     窗内「自动修复」直接置灰，并把 why 当指路文案显示出来；字段缺失才回落到本层的
 *     「没有 INSTALL_DIR 就修不了」旧判据（见 pluginRepairBlockedReason）。
 *     repairToken 缺省时按「错误身份 + at」自己生成：一条错误一个 token，
 *     自动修复额度与二次报告窗都按它发（见 pluginRepairClaimAuto / ClaimReport）。
 *   window.api.pluginRepairReport(payload)  → invoke('pluginRepair:report', payload)
 *       { event:'shown'|'accepted'|'ignored'|'console'|'fail', pluginId, code, sessionId, note }
 *   window.api.pluginRepairResult(payload)  → invoke('pluginRepair:result', payload)
 *       { pluginId, code, sessionId, workspace, ok, repairOk, outcome, reason }
 *   两个 report 通道都不要求主进程必须存在 handler（并行落地），调用一律吞异常。
 *
 * 为什么不走插件窗里的隐藏 Agent：那种修复只在插件控制台留一行「自我修复完成」，用户既看不到
 * 它改了哪些文件，也无法中途插手；而报错时用户往往正盯着画布，画布上的节点 / 工作流上下文只有
 * 渲染层拿得到（本模块把它一并写进提示词）。
 *
 * 修完之后的收尾（本文件后半段 pluginRepairJudge / pluginRepairRestartService）：等那次会话本轮
 * 结束 → 读末条 assistant 正文按 repair_ok=1 / ok=true 判定，正文没给结论再兜底读 INSTALL_DIR 下的
 * 结果文件（兼容各宿主自己约定的 .h3-agent-result 式命名）。判成成功就按 pluginId 调该服务自己的
 * 重启入口（h3Start / music3Start / ttsStart / llamaStart / asrStart；remotion 无常驻服务 → 改成
 * 重跑报错那个节点，拿不到节点就只提示可直接重新生成），toast「<插件> 服务已重启」并刷新插件卡片
 * 与该节点状态；判成失败 / 被终止就**再弹一次**报告窗（附修复结论与 reason）。
 * 两条收敛线缺一不可：同一 repairToken 只允许领到一次自动修复额度、也只允许弹一次二次报告窗，
 * 且二次窗内不再放「自动修复」按钮 —— 否则「报错→修→没修好→再弹→再修」会把用户淹在弹窗里。
 *
 * 依赖（全部是调用期取的其它模块全局函数）：openOverlay / closeOverlay / ovShellBox / $ /
 * toast / I18n / S / nodeById / newAgentSession / persistAgentSession / renderAgentSession /
 * renderAgentSessionSidebar / setView / agentSessionSend / agentSessionById / playNode /
 * refreshMediaNodeUi / probeMediaBackend / looksLikeBackendConnError / refresh*PluginCard。
 * 样式在 css/repair.css。 */

/* 插件 id / kind → 该插件的安装类 skill（【自我修复】模式的唯一真源在 skill 正文里）。
   remotion 与桌宠（pet / bongochat）**故意不在表里**：它们没有 Agent 安装链配套的 skill，
   报错时走 pluginRepairPromptText 的「本插件没有配套的内置 skill → 按日志证据自行判断根因」分支。 */
const PLUGIN_REPAIR_SKILLS = {
  music3: "minimax-music3-install",
  "minimax-music-3": "minimax-music3-install",
  "music3-local": "minimax-music3-install",
  yue2: "yue2-local-install",
  yue: "yue2-local-install",
  "yue2-local": "yue2-local-install",
  sensenova: "sensenova-local-install",
  "sensenova-local": "sensenova-local-install",
  "sensenova-u1": "sensenova-local-install",
  h3: "minimax-h3-install",
  "minimax-h3": "minimax-h3-install",
  "h3-local": "minimax-h3-install",
  tts: "tts-local-install",
  "tts-local": "tts-local-install",
  "gpt-sovits": "tts-local-install",
  llama: "llama-local-install",
  "llama-local": "llama-local-install",
  asr: "asr-local-install",
  "asr-local": "asr-local-install",
  "qwen-asr": "asr-local-install",
};

/* 插件 id / kind → 打开它自己控制台窗的 preload 桥方法名（「打开控制台看日志」用） */
const PLUGIN_REPAIR_CONSOLE = {
  music3: "music3Open",
  "minimax-music-3": "music3Open",
  "music3-local": "music3Open",
  yue2: "yue2Open",
  yue: "yue2Open",
  "yue2-local": "yue2Open",
  sensenova: "sensenovaOpen",
  "sensenova-local": "sensenovaOpen",
  "sensenova-u1": "sensenovaOpen",
  h3: "h3Open",
  "minimax-h3": "h3Open",
  "h3-local": "h3Open",
  tts: "ttsOpen",
  "tts-local": "ttsOpen",
  llama: "llamaOpen",
  "llama-local": "llamaOpen",
  asr: "asrOpen",
  "asr-local": "asrOpen",
  remotion: "remotionOpen",
};

/* 插件 id / kind → 修完之后该调的「该服务自己的重启入口」与卡片刷新口。
   resident:false（remotion / 桌宠）没有常驻后端 —— 修完不存在「重启服务」这回事，
   改成直接重跑报错那个节点（拿不到节点就只提示可以重新生成了）。
   results: 结果文件名兼容清单。各宿主早就在用 `.h3-agent-result` 式命名
   （见 h3/main-h3.js 的 resultMarker / skills/*-install 的收尾条款），
   会话正文没给结论时按这里逐个读 INSTALL_DIR 下的结果文件兜底判定。
   cards: 插件对话框里这张卡片的 data-plugin-id（顶栏「插件」窗开着时才需要就地刷）。
   桌宠（pet / bongochat）没有配套 skill、也没有登记的启停入口 → 与 remotion 同一档。 */
const PLUGIN_REPAIR_SERVICE_BASE = {
  h3: {
    label: "MiniMax H3",
    resident: true,
    start: "h3Start",
    stop: "h3Stop",
    status: "h3Status",
    card: "refreshH3PluginCard",
    cards: ["minimax-h3"],
    results: [".h3-agent-result"],
  },
  music3: {
    label: "MiniMax Music 3",
    resident: true,
    start: "music3Start",
    stop: "music3Stop",
    status: "music3Status",
    card: "refreshMusic3PluginCard",
    cards: ["minimax-music3"],
    results: [".music3-agent-result"],
  },
  yue2: {
    label: "YuE2 本地音乐",
    resident: true,
    start: "yue2Start",
    stop: "yue2Stop",
    status: "yue2Status",
    card: "refreshYuePluginCard",
    cards: ["yue2-local"],
    results: [".yue-agent-result"],
  },
  sensenova: {
    label: "SenseNova 图像",
    resident: true,
    start: "sensenovaStart",
    stop: "sensenovaStop",
    status: "sensenovaStatus",
    card: "refreshSensenovaPluginCard",
    cards: ["sensenova-local"],
    results: [".sensenova-agent-result"],
  },
  tts: {
    label: "GPT-SoVITS TTS",
    resident: true,
    start: "ttsStart",
    stop: "ttsStop",
    status: "ttsStatus",
    card: "refreshTtsPluginCard",
    cards: ["tts-local"],
    results: [".tts-agent-result"],
  },
  llama: {
    label: "llama.cpp",
    resident: true,
    start: "llamaStart",
    stop: "llamaStop",
    status: "llamaStatus",
    card: "refreshLlamaPluginCard",
    cards: ["llama-local"],
    results: [".llama-agent-result"],
  },
  asr: {
    label: "Qwen3-ASR",
    resident: true,
    start: "asrStart",
    stop: "asrStop",
    status: "asrStatus",
    card: "refreshAsrPluginCard",
    cards: ["asr-local"],
    results: [".asr-agent-result"],
  },
  remotion: {
    label: "Remotion",
    resident: false,
    card: "refreshRemotionPluginCard",
    cards: ["remotion"],
    results: [".remotion-agent-result"],
  },
  /* 桌宠：没有安装类 skill（走「自行判断根因」提示词分支），也没有登记的服务启停入口
     → resident:false，修完按「无常驻服务」收尾（有节点就重跑节点，没有就提示可重试）。 */
  pet: {
    label: "BongoChat",
    resident: false,
    card: "refreshPetPluginCard",
    cards: ["bongochat"],
    results: [".pet-agent-result"],
  },
};

/* 与 PLUGIN_REPAIR_SKILLS 同一套别名口径：主进程报 id 还是报 kind 都接得住 */
const PLUGIN_REPAIR_SERVICE = (function expandPluginRepairService() {
  const alias = {
    h3: ["h3", "minimax-h3", "h3-local", "video_gen"],
    music3: ["music3", "minimax-music3", "minimax-music-3", "music3-local", "music_gen"],
    yue2: ["yue2", "yue", "yue2-local", "yue_gen"],
    sensenova: ["sensenova", "sensenova-local", "sensenova-u1", "sensenova_gen"],
    tts: ["tts", "tts-local", "gpt-sovits", "tts_gen"],
    llama: ["llama", "llama-local", "llama-cpp"],
    asr: ["asr", "asr-local", "qwen-asr"],
    remotion: ["remotion", "remotion-video", "remotion-render"],
    pet: ["pet", "bongochat", "bongo-cat", "deskpet"],
  };
  const out = {};
  for (const key of Object.keys(alias)) {
    for (const id of alias[key]) out[id] = PLUGIN_REPAIR_SERVICE_BASE[key];
  }
  return out;
})();

function pluginRepairServiceOf(info) {
  if (!info) return null;
  return PLUGIN_REPAIR_SERVICE[info.pluginId] || PLUGIN_REPAIR_SERVICE[info.kind] || null;
}

/* 后端此刻「在服役」的判据各家字段名不同（Comfy / Gradio / API / llama-server） */
function pluginRepairStatusBusy(st) {
  return !!(
    st &&
    (st.running ||
      st.comfyUp ||
      st.apiUp ||
      st.gradioUp ||
      st.serverUp ||
      st.up ||
      st.wantRunning)
  );
}

const PLUGIN_REPAIR_DUP_MS = 45 * 1000; /* 同一条错误在这段时间内只弹一次 */
const PLUGIN_REPAIR_LOG_CHARS = 24000; /* 窗内日志尾部显示上限 */
const PLUGIN_REPAIR_FOCUS_CHARS = 8000; /* 进提示词的「最近失败焦点」上限 */
const PLUGIN_REPAIR_TAIL_CHARS = 12000; /* 进提示词的 console 尾部上限 */

/* 已经弹过的错误（key → 时间戳）：主进程重试链路可能连推同一条，别刷窗 */
const _pluginRepairSeen = new Map();
/* repairToken 台账：一条错误 = 一个 token（载荷没给就在归一按错误身份生成）。
   自动修复额度与二次报告窗各只发一次 —— 这是「修不动就一直弹」的唯一闸门。 */
const _pluginRepairAutoUsed = new Set();
const _pluginRepairReportShown = new Set();

function pluginRepairTokenLedgerAdd(set, token) {
  if (!token || set.has(token)) return false;
  set.add(token);
  /* 会话生命周期内不断报错也别把表撑爆：丢最早的一半（token 只在近期错误上有意义） */
  if (set.size > 400) {
    let drop = 200;
    for (const t of set) {
      if (drop-- <= 0) break;
      set.delete(t);
    }
  }
  return true;
}

/** 只看不动账本：本 token 的自动修复额度是否已经用完（用于把按钮置灰而不是点了才拒绝） */
function pluginRepairAutoSpent(info) {
  const t = String((info && info.repairToken) || "");
  if (!t) return !!(info && info.started);
  return _pluginRepairAutoUsed.has(t);
}

/**
 * 「自动修复」按不了的原因（返回空串 = 可以修）。判定口径按优先级：
 * ① 主进程说了 repairable:false → 直接用它的 why（不可修清单 + 指路文案的唯一真源在
 *    plugin-error-repair.js，渲染层不再抄一份错误码清单）；why 万一没给全也有兜底文案。
 * ② 拿不到可写工作区（INSTALL_DIR 为空）→ 一律不可修：修复会话没有工作区就会落到默认
 *    工作区，等于让 Agent 去改别的目录，比不修更糟。主进程只凭「取到了日志尾部」判可修时，
 *    这里仍会拦下来（它判的是「值不值得修」，本层还要管「修的地方在哪」）。
 * ③ 其余（含主进程没表态）→ 可修。
 */
function pluginRepairBlockedReason(info) {
  if (!info) return "";
  if (info.repairable === false)
    return (
      String(info.why || "").trim() ||
      I18n.t("主进程判定这条错误无法自动修复（让 Agent 再跑一遍也不会变好），请按上面的日志手动处理。")
    );
  if (!info.installDir)
    return (
      String(info.why || "").trim() ||
      I18n.t(
        "该插件没有上报安装目录，无法确定可写工作区：自动修复不可用，请打开控制台看日志后手动处理。",
      )
    );
  return "";
}

/** 领取本 token 唯一一次「自动修复」额度：领不到 = 已经修过一次，绝不再自动修 */
function pluginRepairClaimAuto(info) {
  const t = String((info && info.repairToken) || "");
  if (!t) return !!(info && !info.started);
  return pluginRepairTokenLedgerAdd(_pluginRepairAutoUsed, t);
}

/** 领取本 token 唯一一次「二次报告窗」额度：领不到 = 只 toast，绝不再弹窗 */
function pluginRepairClaimReport(info) {
  const t = String((info && info.repairToken) || "");
  if (!t) return !!(info && !info.reportShown);
  if (!pluginRepairTokenLedgerAdd(_pluginRepairReportShown, t)) return false;
  info.reportShown = true;
  return true;
}

/* #overlay 全应用独一份：正开着别的对话框时先排队，等它关掉再显示（绝不顶掉用户改到一半的窗） */
const _pluginRepairQueue = [];
let _pluginRepairDrainTimer = 0;

/* ── 载荷归一：字段名兼容，缺项回落 ── */
function pluginRepairPick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null) continue;
    const s = typeof v === "string" ? v : String(v);
    if (s.trim()) return s.trim();
  }
  return "";
}

/* 日志可能是字符串 / 行数组 / { text } —— 一律收成字符串 */
function pluginRepairText(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => pluginRepairText(x)).filter(Boolean).join("\n");
  if (typeof v === "object")
    return pluginRepairPick(v.text, v.tail, v.message, v.value);
  return String(v);
}

/* 截断并标注，避免超长日志把窗与提示词撑爆 */
function pluginRepairClip(s, max) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return "…" + t.slice(t.length - max);
}

function pluginRepairNormalize(raw) {
  const p = raw && typeof raw === "object" ? raw : { message: pluginRepairText(raw) };
  const pluginId = pluginRepairPick(p.pluginId, p.plugin, p.id, p.handler, p.kind);
  const kind = pluginRepairPick(p.kind, p.handler, p.pluginId, p.plugin);
  const info = {
    pluginId: pluginId,
    pluginName: pluginRepairPick(p.pluginName, p.name, p.title, p.displayName, pluginId),
    kind: kind,
    installDir: pluginRepairPick(p.installDir, p.dir, p.installPath, p.root),
    scaffoldRef: pluginRepairPick(p.scaffoldRef, p.scaffold, p.packDir, p.scaffoldDir),
    skill: pluginRepairPick(
      p.skill,
      p.skillName,
      PLUGIN_REPAIR_SKILLS[pluginId],
      PLUGIN_REPAIR_SKILLS[kind],
    ),
    code: pluginRepairPick(p.code, p.errorCode, p.errCode, p.status),
    message: pluginRepairText(p.message || p.error || p.text || p.reason || p.detail),
    log: pluginRepairText(p.log || p.logTail || p.consoleTail || p.tail || p.console),
    focus: pluginRepairText(p.focus || p.failedFocus || p.focusLine || p.errorFocus),
    nodeId: pluginRepairPick(p.nodeId, p.nid),
    nodeTitle: pluginRepairPick(p.nodeTitle, p.nodeName),
    nodeKind: pluginRepairPick(p.nodeKind),
    workflowId: pluginRepairPick(p.workflowId, p.wfId),
    workflowName: pluginRepairPick(p.workflowName, p.wfName, p.canvasName),
    /* 主进程没点名就按通用命名写：不抢插件自己的 .install-ok（那是它的安装状态判据） */
    marker: pluginRepairPick(p.marker, p.markerFile) || ".repair-ok",
    resultFile: pluginRepairPick(p.resultFile, p.resultMarker) || ".agent-repair-result",
    at: Number(p.at) || Date.now(),
    sessionId: "",
    box: null,
    started: false,
    /* 本条错误的身份令牌：自动修复额度与二次弹窗都按它发（见 pluginRepairClaimAuto） */
    repairToken: pluginRepairPick(p.repairToken, p.token, p.dedupeToken),
    /* 可修复性判定：主进程 plugin-error-repair.js 的 judgeRepairability 是唯一真源，
       why = 不可修时的指路文案（该做什么 / 去哪个控制台）。渲染层不再自己判「哪一类错误修不了」。
       载荷里没这个布尔字段（老宿主、或没走报错总线的直接推送）→ null，本层回落到旧判据。 */
    repairable: typeof p.repairable === "boolean" ? p.repairable : null,
    why: pluginRepairPick(p.why, p.whyNot, p.notRepairableWhy),
    reportShown: false,
    __normalized: true,
  };
  /* 主进程没给 token（并行落地期很正常）→ 按错误身份 + 发生时刻自己生成一个：
     同一条错误在 PLUGIN_REPAIR_DUP_MS 内被连推只会有一条 info，等价于一条错误一个 token。 */
  if (!info.repairToken) {
    try {
      info.repairToken = pluginRepairKey(info) + "|" + info.at;
    } catch (_) {
      info.repairToken = "repair-" + info.at;
    }
  }
  /* 节点与画布上下文：只给了 id 时按当前画布补标题（拿不到就不显示，绝不瞎编） */
  if ((!info.nodeTitle || !info.nodeKind) && info.nodeId && typeof nodeById === "function") {
    try {
      const n = nodeById(info.nodeId);
      if (n) {
        info.nodeTitle = info.nodeTitle || String(n.title || "");
        info.nodeKind = info.nodeKind || String(n.kind || "");
      }
    } catch (_) {}
  }
  if (!info.workflowName && info.workflowId && typeof S === "object" && S.wf) {
    if (String(S.wf.id || "") === info.workflowId)
      info.workflowName = String(S.wf.name || "");
  }
  return info;
}

/* 界面上「这个插件叫什么」：名字 → id → 兜底「插件」（主进程给不全也不空着） */
function pluginRepairName(info) {
  return pluginRepairPick(info.pluginName, info.pluginId) || I18n.t("插件");
}

function pluginRepairKey(info) {
  return [
    info.pluginId || info.pluginName,
    info.code || "",
    String(info.message || info.focus || info.log || "").slice(-240),
  ].join("|");
}

/* ── 主进程回执（桥可能还没人接，一律吞异常） ── */
function pluginRepairReport(info, event, note) {
  try {
    if (!window.api || typeof window.api.pluginRepairReport !== "function") return;
    const r = window.api.pluginRepairReport({
      event: event,
      pluginId: info.pluginId || "",
      pluginName: info.pluginName || "",
      code: info.code || "",
      sessionId: info.sessionId || "",
      note: String(note || "").slice(0, 600),
      at: Date.now(),
    });
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

function pluginRepairSendResult(info, st, res) {
  try {
    if (!window.api || typeof window.api.pluginRepairResult !== "function") return;
    const r = window.api.pluginRepairResult(
      Object.assign(
        {
          pluginId: info.pluginId || "",
          pluginName: info.pluginName || "",
          code: info.code || "",
          sessionId: st && st.id ? st.id : "",
          workspace: (st && st.workspace) || info.installDir || "",
        },
        res || {},
      ),
    );
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

/* ── 弹窗排队：#overlay 独一份，别的窗开着就先不抢 ── */
function pluginRepairOverlayBusy() {
  const ov = document.getElementById("overlay");
  return !!(ov && ov.style && ov.style.display === "flex");
}

function pluginRepairDrainStop() {
  if (_pluginRepairDrainTimer) {
    clearInterval(_pluginRepairDrainTimer);
    _pluginRepairDrainTimer = 0;
  }
}

function pluginRepairDrainOnce() {
  if (!_pluginRepairQueue.length) {
    pluginRepairDrainStop();
    return;
  }
  if (pluginRepairOverlayBusy()) return;
  const next = _pluginRepairQueue.shift();
  openPluginRepairDialog(next);
}

function pluginRepairEnqueue(info) {
  _pluginRepairQueue.push(info);
  try {
    toast(
      I18n.t("插件报错详情已排队（关掉当前窗口后显示）") +
        " · " +
        pluginRepairName(info),
      "warn",
    );
  } catch (_) {}
  if (_pluginRepairDrainTimer) return;
  let ticks = 0;
  _pluginRepairDrainTimer = setInterval(() => {
    if (++ticks > 600) {
      pluginRepairDrainStop();
      _pluginRepairQueue.length = 0;
      return;
    }
    pluginRepairDrainOnce();
  }, 1200);
}

/* ── 窗内小工具 ── */
function pluginRepairHint(body, text) {
  const d = document.createElement("div");
  d.className = "settings-hint plg-repair-hint";
  d.textContent = text;
  body.appendChild(d);
  return d;
}

function pluginRepairRow(body, label, value) {
  const t = String(value == null ? "" : value).trim();
  if (!t) return null;
  const row = document.createElement("div");
  row.className = "plg-repair-row";
  const k = document.createElement("span");
  k.className = "plg-repair-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "plg-repair-v";
  v.textContent = t;
  row.appendChild(k);
  row.appendChild(v);
  body.appendChild(row);
  return row;
}

function pluginRepairPre(body, cls, text) {
  const pre = document.createElement("pre");
  pre.className = "plg-repair-pre " + cls;
  pre.textContent = text;
  body.appendChild(pre);
  return pre;
}

function pluginRepairDetails(body, label, text) {
  const det = document.createElement("details");
  det.className = "plg-repair-log";
  const sum = document.createElement("summary");
  sum.textContent = label;
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "plg-repair-pre";
  pre.textContent = text;
  det.appendChild(pre);
  body.appendChild(det);
  return det;
}

function pluginRepairBtn(foot, label, fn, opts) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini " + ((opts && opts.cls) || "");
  b.textContent = I18n.t(label);
  if (opts && opts.title) b.title = I18n.t(opts.title);
  if (opts && opts.disabled) b.disabled = true;
  b.onclick = (ev) => {
    ev.preventDefault();
    try {
      const r = fn(b);
      /* 异步动作（发 IPC / 开新会话）的失败不变成未处理拒绝：就地 toast + 交回调用方 */
      if (r && typeof r.catch === "function") {
        b.disabled = true;
        r.catch((e) => {
          b.disabled = false;
          try {
            toast(I18n.t("操作失败：") + ((e && e.message) || String(e)), "err");
          } catch (_) {}
        });
      }
    } catch (e) {
      try {
        toast(I18n.t("操作失败：") + ((e && e.message) || String(e)), "err");
      } catch (_) {}
    }
  };
  foot.appendChild(b);
  return b;
}

/* ── 错误报告窗（persistent：只有显式按钮 / ✕ / Esc 能关；默认可最小化到状态栏） ── */
function openPluginRepairDialog(raw) {
  const info = raw && raw.__normalized ? raw : pluginRepairNormalize(raw);
  const name = pluginRepairName(info);
  openOverlay(I18n.t("插件出错") + " · " + name);
  /* persistent 是全应用铁律：这里显式表达意图（点蒙层 / 点外部一律不关窗） */
  overlayPersistent = true;
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  if (!body || !foot) return;
  body.innerHTML = "";
  foot.innerHTML = "";

  pluginRepairHint(
    body,
    I18n.t(
      "插件运行期报错。可以交给「自动修复」：会新建一条看得见的会话（工作区 = 该插件的安装目录）按 skill 的【自我修复】模式分析日志并动手修；也可以先看日志自己处理，或直接忽略。",
    ),
  );

  pluginRepairRow(body, I18n.t("插件"), name + (info.pluginId ? "（" + info.pluginId + "）" : ""));
  pluginRepairRow(body, I18n.t("错误码"), info.code);
  if (info.nodeTitle || info.nodeId) {
    const node = info.nodeTitle || I18n.t("（未知标题）");
    const extra = [info.nodeKind, info.nodeId].filter(Boolean).join(" · ");
    pluginRepairRow(body, I18n.t("出问题的节点"), extra ? node + "（" + extra + "）" : node);
  }
  pluginRepairRow(body, I18n.t("所属画布"), info.workflowName || info.workflowId);
  pluginRepairRow(body, "INSTALL_DIR", info.installDir);
  pluginRepairRow(body, "SCAFFOLD_REF", info.scaffoldRef);
  pluginRepairRow(body, "skill", info.skill);

  if (String(info.message || "").trim()) {
    const lab = document.createElement("div");
    lab.className = "plg-repair-sub";
    lab.textContent = I18n.t("错误正文");
    body.appendChild(lab);
    pluginRepairPre(body, "plg-repair-err", info.message);
  }
  if (String(info.focus || "").trim()) {
    pluginRepairDetails(
      body,
      I18n.t("展开：console 最近失败焦点"),
      pluginRepairClip(info.focus, PLUGIN_REPAIR_LOG_CHARS),
    );
  }
  if (String(info.log || "").trim()) {
    const lines = info.log.split(/\r?\n/).filter((x) => x.trim()).length;
    pluginRepairDetails(
      body,
      I18n.t("展开：console 日志尾部（共") + " " + lines + " " + I18n.t("行）"),
      pluginRepairClip(info.log, PLUGIN_REPAIR_LOG_CHARS),
    );
  }
  /* 不可修的指路文案：真源在主进程（why），窗内原样显示 —— 用户要的是一句「那我现在该做什么」，
     而不是一个点不动的按钮。放在日志之后，先看现场再看指路。
     （why 是主进程的中文文案，这里过一道 I18n.t：英文界面命中词条就翻，没命中就照原样出。） */
  const blocked = pluginRepairBlockedReason(info);
  if (blocked) pluginRepairHint(body, I18n.t(blocked));

  const canRepair = !blocked && !info.started && !pluginRepairAutoSpent(info);
  pluginRepairBtn(
    foot,
    "🤖 自动修复",
    () => {
      info.started = true;
      return pluginRepairRun(info).catch((e) => {
        info.started = false;
        pluginRepairReport(info, "fail", String((e && e.message) || e));
        throw e;
      });
    },
    {
      cls: "primary",
      disabled: !canRepair,
      title: pluginRepairAutoSpent(info)
        ? I18n.t("本条错误的自动修复已经用过一次，请对照修复结果与日志手动处理")
        : info.started
          ? I18n.t("这条错误已经交给自动修复会话")
          : blocked
            ? blocked
            : I18n.t("新建一条左侧栏会话，把日志与上下文交给它修复（工作区 = INSTALL_DIR）"),
    },
  );
  pluginRepairBtn(
    foot,
    "打开控制台看日志",
    () => pluginRepairOpenConsole(info),
    { title: I18n.t("打开该插件自己的控制台（完整日志在那里）") },
  );
  pluginRepairBtn(
    foot,
    "忽略",
    () => {
      pluginRepairReport(info, "ignored", "user dismissed");
      pluginRepairClose(info);
    },
    { title: I18n.t("关掉本窗，不做任何修复动作") },
  );

  /* 记下这只窗归属本错误：会话跑完 / 排队显示时按身份判断，绝不误关别人的窗 */
  try {
    info.box = typeof ovShellBox === "function" ? ovShellBox() : null;
  } catch (_) {
    info.box = null;
  }
  pluginRepairReport(info, "shown", "");
}

/* 关掉本模块那只错误报告窗（只有它还是当前窗时才动 #overlay） */
function pluginRepairClose(info) {
  try {
    const live = typeof ovShellBox === "function" ? ovShellBox() : null;
    if (!info.box || !live || live === info.box) closeOverlay();
  } catch (_) {}
  info.box = null;
  pluginRepairDrainOnce();
}

/* ── 「打开控制台看日志」：优先插件自己的控制台，回落通用 appPluginsOpen ── */
async function pluginRepairOpenConsole(info) {
  const api = window.api || {};
  const fnName =
    PLUGIN_REPAIR_CONSOLE[info.pluginId] || PLUGIN_REPAIR_CONSOLE[info.kind] || "";
  const tried = [];
  const call = async (name, arg) => {
    if (typeof api[name] !== "function") return null;
    tried.push(name);
    try {
      return await (arg ? api[name](arg) : api[name]());
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
  let r = fnName ? await call(fnName, "") : null;
  if ((!r || r.ok === false) && info.pluginId)
    r = await call("appPluginsOpen", info.pluginId);
  if (r && r.ok === false) {
    toast(I18n.t("打开控制台失败：") + (r.error || I18n.t("未知错误")), "err");
    pluginRepairReport(info, "console", "fail:" + (r.error || ""));
    return;
  }
  if (!r && !tried.length) {
    toast(I18n.t("该插件没有可打开的控制台窗口，请看上面的日志尾部"), "warn");
    return;
  }
  pluginRepairReport(info, "console", "");
}

/* ── 修复提示词：skill 的【自我修复】模式 + 目录 + 错误码 + 节点/画布上下文 + 日志焦点 ── */
function pluginRepairPromptText(info) {
  const L = [];
  L.push(
    (info.skill
      ? I18n.t("请使用 skill「") + info.skill + I18n.t("」的【自我修复】模式。")
      : I18n.t("本插件没有配套的内置 skill：请按日志证据自行判断根因并修复，不要套用不匹配的旧故障剧本。")),
  );
  L.push(I18n.t("当前工作区（可写）= INSTALL_DIR=") + info.installDir);
  if (info.scaffoldRef)
    L.push(
      "SCAFFOLD_REF=" + info.scaffoldRef + I18n.t("（仅参考，不要当作已安装，也不要改这个目录）"),
    );
  L.push(
    I18n.t("插件：") +
      pluginRepairName(info) +
      (info.pluginId ? "（id=" + info.pluginId + "）" : ""),
  );
  if (info.code) L.push(I18n.t("错误码：") + info.code);
  const ctx = [];
  if (info.nodeTitle || info.nodeId) {
    const tail = [info.nodeKind, info.nodeId].filter(Boolean).join(" · ");
    ctx.push(
      I18n.t("出问题的节点：") +
        (info.nodeTitle || I18n.t("（无标题）")) +
        (tail ? "（" + tail + "）" : ""),
    );
  }
  if (info.workflowName || info.workflowId)
    ctx.push(I18n.t("所属画布：") + (info.workflowName || info.workflowId));
  if (ctx.length) L.push(ctx.join("\n"));
  if (info.message)
    L.push(I18n.t("错误正文：") + "\n```\n" + String(info.message).slice(0, 4000) + "\n```");
  if (info.focus)
    L.push(
      I18n.t("=== 最近失败焦点（以它为准，更早的 Traceback 可能已过时）===") +
        "\n```\n" +
        pluginRepairClip(info.focus, PLUGIN_REPAIR_FOCUS_CHARS) +
        "\n```",
    );
  if (info.log)
    L.push(
      I18n.t("=== console 最近尾部（更多上下文）===") +
        "\n```\n" +
        pluginRepairClip(info.log, PLUGIN_REPAIR_TAIL_CHARS) +
        "\n```",
    );
  L.push(
    "\n" +
      I18n.t(
        "纪律（一律遵守）：只允许修改 INSTALL_DIR 内的文件（工作区之外一律不碰）；不要启动后端服务 / ComfyUI / 模型进程；不要删除用户产物目录（output/ 等）；模型与权重已就绪则勿重复下载，只补缺项；skill 里的「已知故障」章节仅当日志证据确实匹配时才参考。优先修依赖 / 脚本 / 配置，再考虑重装。",
      ),
  );
  L.push(
    I18n.t("完成后：在 INSTALL_DIR 根下创建标记文件 ") +
      info.marker +
      I18n.t("，并写入结果文件 ") +
      info.resultFile +
      I18n.t("（首行 ok=true，可附 reason= 已修复的简要根因），然后在本会话回复里给出 repair_ok=1 与简要根因。"),
  );
  L.push(
    I18n.t("修不动：") +
      info.resultFile +
      I18n.t(" 写 ok=false 与 reason=<哪一条没交付 + 具体报错>，并在回复里说清还需要用户做什么。"),
  );
  return L.join("\n");
}

/* ==================== 修完之后：判定 → 重启该服务 → 刷新；或二次报告窗 ==================== */

/* 末条 assistant 正文里的结论记号：各 skill 的统一口径是 repair_ok=1（安装链写 install_ok=1），
   同时兼容结果文件那套首行写法（ok=true / ok=false）。返回 true / false / null（没说清）。 */
function pluginRepairVerdictFromText(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (
    /\brepair_ok\s*=\s*0\b|\brepair_ok\s*=\s*false\b|\binstall_ok\s*=\s*0\b|\binstall_ok\s*=\s*false\b|\bok\s*=\s*false\b/i.test(
      s,
    )
  )
    return false;
  if (
    /\brepair_ok\s*=\s*1\b|\brepair_ok\s*=\s*true\b|\binstall_ok\s*=\s*1\b|\binstall_ok\s*=\s*true\b|\bok\s*=\s*true\b/i.test(
      s,
    )
  )
    return true;
  return null;
}

function pluginRepairJoinPath(dir, name) {
  const d = String(dir || "").replace(/[\\/]+$/, "");
  const n = String(name || "").replace(/^[\\/]+/, "");
  if (!d) return n;
  if (!n) return d;
  const sep = d.indexOf("\\") >= 0 && d.indexOf("/") < 0 ? "\\" : "/";
  return d + sep + n;
}

function pluginRepairReasonFromText(text) {
  const m = String(text || "").match(/reason\s*[=:]\s*([^\r\n]+)/i);
  return m ? String(m[1] || "").trim() : "";
}

/* 结果文件兜底：正文没写清结论时，按 info.resultFile → .agent-repair-result →
   .h3-agent-result 式（各宿主自己早就约定的那份）逐个试。返回 { path, ok, reason } 或 null。 */
async function pluginRepairReadResultFile(info) {
  const api = window.api || {};
  if (!info || !info.installDir || typeof api.fileReadText !== "function") return null;
  const svc = pluginRepairServiceOf(info);
  const names = [];
  const push = (n) => {
    const s = String(n || "").trim();
    if (s && names.indexOf(s) < 0) names.push(s);
  };
  push(info.resultFile);
  push(".agent-repair-result");
  for (const n of (svc && svc.results) || []) push(n);
  for (const name of names) {
    const p = pluginRepairJoinPath(info.installDir, name);
    let r = null;
    try {
      r = await api.fileReadText(p);
    } catch (_) {
      continue;
    }
    if (!r || !r.exists || !String(r.content || "").trim()) continue;
    const raw = String(r.content);
    const hasTrue = /\bok\s*=\s*true\b/i.test(raw);
    const hasFalse = /\bok\s*=\s*false\b/i.test(raw);
    return {
      path: p,
      ok: hasTrue && !hasFalse ? true : hasFalse ? false : null,
      reason: pluginRepairReasonFromText(raw),
    };
  }
  return null;
}

/**
 * 两处证据合成一份结论：任何一处明确说「没修好」就是失败；两处都没结论也按失败处理。
 * 为什么宁可判失败也不重启：判错成成功 = 把没修好的后端又拉起来一次，用户接着撞同一个报错，
 * 而且这一次连报告窗都没有 —— 比「修完了但没敢自动重启，请你确认」伤得多。
 * opts = { text 末条 assistant 正文, error 发起/本轮报错, aborted 用户终止了本轮 }
 */
async function pluginRepairJudge(info, opts) {
  opts = opts || {};
  const text = String(opts.text || "");
  const errText = String(opts.error || "");
  const aborted = !!opts.aborted;
  const fromText = errText || aborted ? null : pluginRepairVerdictFromText(text);
  const file = await pluginRepairReadResultFile(info);
  const textReason = pluginRepairReasonFromText(text) || pluginRepairReasonFromText(errText);
  const clip = (s) => String(s || "").trim().slice(0, 1200);
  const v = { ok: false, reason: "", source: "", text: text, file: file, aborted: aborted, error: errText };
  if (errText) {
    v.reason = clip(errText);
    v.source = "send_error";
  } else if (aborted) {
    v.reason = clip(textReason || I18n.t("修复会话被终止，没有给出结论"));
    v.source = "aborted";
  } else if (file && file.ok === false) {
    v.reason = clip(file.reason || textReason || "result_file_ok_false");
    v.source = file.path;
  } else if (fromText === false) {
    v.reason = clip(textReason || "agent_reported_failure");
    v.source = "session_text";
  } else if (file && file.ok === true) {
    v.ok = true;
    v.reason = clip(file.reason || textReason);
    v.source = file.path;
  } else if (fromText === true) {
    v.ok = true;
    v.reason = clip(textReason);
    v.source = "session_text";
  } else {
    v.reason = clip(
      textReason ||
        (text.trim() ? "no_repair_verdict" : I18n.t("修复会话没有给出结论（正文缺 repair_ok=1 / ok=true）")),
    );
    v.source = "none";
  }
  return v;
}

/* 重跑报错那个节点：remotion 这类无常驻后端的插件，「修好了」的直接体现就是这条生成能跑通。
   延一拍再交给 playNode —— 此刻收尾渲染还在跑，同帧重跑会打架。 */
function pluginRepairRerunNode(info) {
  try {
    if (!info || !info.nodeId || typeof nodeById !== "function" || typeof playNode !== "function")
      return null;
    const n = nodeById(info.nodeId);
    if (!n) return null;
    setTimeout(() => {
      try {
        playNode(n, true);
      } catch (_) {}
    }, 250);
    return n;
  } catch (_) {
    return null;
  }
}

/**
 * 修复成功后拉起该插件自己的服务。两个必须注意的口径：
 * ① 先 status→stop 再 start：修复过程常留下半死的旧进程，直接 start 会被宿主判成「端口已有人 →
 *    复用」（h3Start 里的 reused:true 就是这个分支），等于根本没重启，下次还是同一个报错；
 * ② 失败不重试、也不再弹窗：只 toast 一句让用户去控制台 —— 自动重试就是报错风暴。
 */
async function pluginRepairRestartService(info) {
  const svc = pluginRepairServiceOf(info);
  const api = window.api || {};
  if (!svc) return { ok: false, note: "unknown_plugin" };
  /* 无常驻服务（remotion）：没有「重启」这一步，改成重跑该节点 / 提示重装完成 */
  if (!svc.resident) {
    const ran = pluginRepairRerunNode(info);
    return { ok: true, noService: true, reran: !!ran };
  }
  if (typeof api[svc.start] !== "function")
    return { ok: false, note: "no_start_bridge:" + svc.start };
  if (typeof api[svc.status] === "function" && typeof api[svc.stop] === "function") {
    try {
      if (pluginRepairStatusBusy(await api[svc.status]())) await api[svc.stop]();
    } catch (_) {}
  }
  let r = null;
  try {
    r = await api[svc.start]({});
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  return {
    ok: !!(r && r.ok !== false),
    error: String((r && r.error) || (r && r.message) || "").slice(0, 300),
  };
}

/* 刷顶栏「插件」窗里的那张卡片：窗没开就不用刷（下次开窗自己重拉状态，不抢用户的窗） */
function pluginRepairRefreshCard(svc) {
  try {
    const fnName = svc && svc.card;
    if (!fnName || typeof window[fnName] !== "function") return;
    for (const id of (svc && svc.cards) || []) {
      const card = document.querySelector('.plugin-tile[data-plugin-id="' + id + '"]');
      if (card) {
        window[fnName](card);
        return;
      }
    }
  } catch (_) {}
}

/* 刷报错节点的状态：那条「后端连不上 / 已退出」的红字此刻已经过期，
   清掉它再把探测链叫回来回写真实在线状态（probeMediaBackend 自己会软刷 UI）。 */
function pluginRepairRefreshNode(info) {
  try {
    if (!info || !info.nodeId || typeof nodeById !== "function") return;
    const n = nodeById(info.nodeId);
    if (!n) return;
    const hadErr = String(n.error || "");
    const stale =
      !!hadErr &&
      (typeof looksLikeBackendConnError !== "function" || looksLikeBackendConnError(hadErr));
    if (stale) {
      n.error = null;
      if (n.remotionStatus && String(n.remotionStatus).indexOf(hadErr) >= 0) n.remotionStatus = "";
      if (n.backendUi && typeof n.backendUi === "object") {
        n.backendUi.ok = null;
        n.backendUi.probing = false;
      }
    }
    if (typeof probeMediaBackend === "function") {
      try {
        probeMediaBackend(n, { quiet: true, force: true });
      } catch (_) {}
    }
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(n, { soft: !stale });
    else if (typeof refreshNodeEl === "function") refreshNodeEl(n.id);
    else if (typeof renderCanvas === "function") renderCanvas();
  } catch (_) {}
}

/* 等 #overlay 空出来再显示：和错误报告窗同一套纪律（绝不顶掉用户改到一半的窗）。
   十分钟还占着就放弃并留一行 toast —— 用户没在看，这时候补一弹只是打扰。 */
function pluginRepairShowWhenIdle(show, onDrop) {
  if (!pluginRepairOverlayBusy()) {
    try {
      show();
    } catch (_) {}
    return;
  }
  let ticks = 0;
  const timer = setInterval(() => {
    if (++ticks > 300) {
      clearInterval(timer);
      try {
        if (onDrop) onDrop();
      } catch (_) {}
      return;
    }
    if (pluginRepairOverlayBusy()) return;
    clearInterval(timer);
    try {
      show();
    } catch (_) {}
  }, 2000);
}

/* 关掉二次报告窗（同样只认自己那只窗，绝不误关别人的） */
function pluginRepairCloseResult(info) {
  try {
    const live = typeof ovShellBox === "function" ? ovShellBox() : null;
    if (!info.resultBox || !live || live === info.resultBox) closeOverlay();
  } catch (_) {}
  info.resultBox = null;
  pluginRepairDrainOnce();
}

/* 「查看修复会话」：关掉本窗 → 切到会话视图并选中那条修复会话（用户在报告窗里看不到细节，
   细节全在会话里：改了哪些文件、卡在哪一条） */
function pluginRepairGotoSession(info) {
  const st =
    info.sessionId && typeof agentSessionById === "function"
      ? agentSessionById(info.sessionId)
      : null;
  try {
    if (typeof closeOverlay === "function") closeOverlay();
  } catch (_) {}
  info.resultBox = null;
  if (!st) {
    try {
      toast(I18n.t("该修复会话已不存在"), "warn");
    } catch (_) {}
    return;
  }
  try {
    if (typeof setView === "function" && typeof S === "object" && S.view !== "agent") setView("agent");
    S.agentActiveId = st.id;
    if (typeof persistAgentSession === "function") persistAgentSession();
    if (typeof renderAgentSession === "function") renderAgentSession();
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  } catch (_) {}
}

/* ── 二次报告窗（修复结果窗）：附修复结论与 reason；窗内不放「自动修复」按钮 ──
   为什么没有那个按钮：本条错误的自动修复额度已经用掉了，再给一次入口 = 用户可以手滑把
   「修不动 → 弹窗 → 再修」的环自己按下去；只留看会话 / 看控制台 / 关闭三条显式出路。 */
function openPluginRepairResultDialog(raw, verdict) {
  const info = raw && raw.__normalized ? raw : pluginRepairNormalize(raw);
  const v = verdict || {};
  const name = pluginRepairName(info);
  openOverlay(I18n.t("修复结果") + " · " + name);
  overlayPersistent = true;
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  if (!body || !foot) return;
  body.innerHTML = "";
  foot.innerHTML = "";

  pluginRepairHint(
    body,
    v.aborted
      ? I18n.t(
          "这次自动修复没跑完（会话被终止），后端服务未重启。本条错误的自动修复额度已用完：不会再自动重试，也不会反复弹窗，请对照下面的结论自己处理。",
        )
      : I18n.t(
          "自动修复会话结束了，但没拿到成功结论（缺 repair_ok=1 / 结果文件写了 ok=false），后端服务未重启。本条错误的自动修复额度已用完：不会再自动重试，也不会反复弹窗，请对照下面的结论与 reason 处理。",
        ),
  );

  pluginRepairRow(body, I18n.t("插件"), name + (info.pluginId ? "（" + info.pluginId + "）" : ""));
  pluginRepairRow(body, I18n.t("原错误码"), info.code);
  pluginRepairRow(body, I18n.t("修复结论"), I18n.t("未成功 · 服务未重启"));
  pluginRepairRow(body, "reason", v.reason || I18n.t("（会话未给出 reason）"));
  pluginRepairRow(body, I18n.t("判定依据"), v.source || "none");
  if (info.nodeTitle || info.nodeId) {
    const node = info.nodeTitle || I18n.t("（未知标题）");
    const extra = [info.nodeKind, info.nodeId].filter(Boolean).join(" · ");
    pluginRepairRow(body, I18n.t("出问题的节点"), extra ? node + "（" + extra + "）" : node);
  }
  pluginRepairRow(body, "INSTALL_DIR", info.installDir);
  if (v.file && v.file.path) pluginRepairRow(body, I18n.t("结果文件"), v.file.path);

  if (String(v.text || "").trim())
    pluginRepairDetails(
      body,
      I18n.t("展开：修复会话末条回复"),
      pluginRepairClip(v.text, PLUGIN_REPAIR_LOG_CHARS),
    );
  if (String(info.log || "").trim())
    pluginRepairDetails(
      body,
      I18n.t("展开：console 日志尾部"),
      pluginRepairClip(info.log, PLUGIN_REPAIR_LOG_CHARS),
    );

  pluginRepairBtn(
    foot,
    "查看修复会话",
    () => pluginRepairGotoSession(info),
    { cls: "primary", title: I18n.t("切到那条会话，看它到底改了什么、卡在哪一步") },
  );
  pluginRepairBtn(
    foot,
    "打开控制台看日志",
    () => pluginRepairOpenConsole(info),
    { title: I18n.t("打开该插件自己的控制台（完整日志在那里）") },
  );
  pluginRepairBtn(foot, "关闭", () => pluginRepairCloseResult(info), {
    title: I18n.t("关掉本窗，不做任何修复动作"),
  });

  try {
    info.resultBox = typeof ovShellBox === "function" ? ovShellBox() : null;
  } catch (_) {
    info.resultBox = null;
  }
}

/* 弹二次报告窗的唯一入口：一 token 一次。领不到额度 = 已经弹过了 → 只 toast 收口，绝不再弹。 */
function pluginRepairShowResultReport(info, verdict) {
  const st = info.sessionId || "";
  if (!pluginRepairClaimReport(info)) {
    try {
      toast(I18n.t("自动修复未成功，结论见该修复会话") + (st ? " · " + st : ""), "warn");
    } catch (_) {}
    return;
  }
  pluginRepairReport(info, "fail", String((verdict && verdict.reason) || "").slice(0, 200));
  pluginRepairShowWhenIdle(
    () => openPluginRepairResultDialog(info, verdict),
    () => {
      try {
        toast(I18n.t("自动修复未成功（结论窗没能插进去显示，请看该修复会话）"), "warn");
      } catch (_) {}
    },
  );
}

/* agentSessionSend 正常会在本轮结束才返回；万一这轮走的是「会话忙 → 入发送队列」分支，
   这里补一轮轮询，保证读到的确实是本轮那条末条 assistant 正文（不是上一轮的旧结论）。 */
async function pluginRepairWaitTurnEnd(st) {
  try {
    if (typeof sessionIsRunning !== "function" || !st) return;
    const step = 1500;
    const max = 2 * 60 * 60 * 1000;
    let waited = 0;
    while (sessionIsRunning(st) && waited < max) {
      await new Promise((r) => setTimeout(r, step));
      waited += step;
    }
  } catch (_) {}
}

/* ── 点「自动修复」：新建左侧栏可见会话 → 设工作区 / 与画布无关 → 发提示词 → 回报结论 ── */
async function pluginRepairRun(info) {
  /* 兜住绕过按钮的调用方（插件窗 / 其它入口自己调 window 上的修复口）：
     判不可修就不领额度、不建会话，指路文案（why）原样 toast 出去。 */
  const blocked = pluginRepairBlockedReason(info);
  if (blocked) {
    toast(I18n.t(blocked), "warn");
    return;
  }
  /* 收敛闸门（一）：同一 repairToken 只发一次自动修复额度。拿不到就是这条错误已经修过一轮，
     直接拒绝，不再新建第二条修复会话 —— 修不动的错误反复自动修 = 弹窗与 token 风暴。 */
  if (!pluginRepairClaimAuto(info)) {
    info.started = true;
    toast(I18n.t("本条错误的自动修复已经用过一次，请对照修复结果与日志手动处理"), "warn");
    return;
  }
  if (typeof newAgentSession !== "function" || typeof agentSessionSend !== "function") {
    toast(I18n.t("会话能力尚未就绪，请稍后再试"), "err");
    return;
  }
  const st = newAgentSession();
  st.title = I18n.t("自动修复") + " · " + pluginRepairName(info);
  /* 标题是本窗的固定口径：锁死，不让首轮自动命名把它改成日志前 24 字 */
  st.titleLocked = true;
  st.titleAuto = false;
  st.workspace = info.installDir;
  /* 与画布无关档（Gate B）：修插件用不上读图 / 改图三件套，整档不注册省约 26K 字符/步 */
  st.canvasFree = true;
  info.sessionId = st.id;
  try {
    if (typeof persistAgentSession === "function") await persistAgentSession();
  } catch (_) {}
  try {
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    /* 切到会话视图：用户要的是「看得见的一条会话在修」 */
    if (typeof setView === "function") setView("agent");
  } catch (_) {}
  pluginRepairReport(info, "accepted", st.id);
  pluginRepairClose(info);

  const prompt = pluginRepairPromptText(info);
  let err = "";
  try {
    await agentSessionSend(prompt, { sessionId: st.id });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  const outcome = err ? "error" : pluginRepairPick(st._roundOutcome, "ok");
  /* 本轮结束（agentSessionSend 会等这一轮跑完才返回；忙时入队的分支再补一轮轮询兜底），
     取末条 assistant 正文 —— 结论只认这一条，不回头翻上一轮的旧说法。 */
  await pluginRepairWaitTurnEnd(st);
  let last = "";
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && String(m.content || "").trim()) {
      last = String(m.content).trim();
      break;
    }
  }
  const verdict = await pluginRepairJudge(info, {
    text: last,
    error: outcome === "error" ? err || "session_error" : "",
    aborted: outcome === "cancelled",
  });
  const repairOk = !!verdict.ok;
  const reason = String(verdict.reason || (repairOk ? "" : "no_repair_verdict"))
    .trim()
    .slice(0, 1200);

  /* 修好了才重启：重启入口只有该插件宿主自己那份（startBackend 里还要跑健康探测），
     所以这一步既不能提前到判定之前，也不能在失败分支里顺手做。 */
  let restart = null;
  if (repairOk) restart = await pluginRepairRestartService(info);

  pluginRepairSendResult(
    info,
    st,
    {
      ok: outcome !== "error",
      repairOk: repairOk,
      outcome: outcome,
      reason: reason,
      source: verdict.source || "",
      restarted: !!(restart && restart.ok && !restart.noService),
      restartError: String((restart && (restart.error || restart.note)) || ""),
    },
  );

  if (repairOk) {
    const name = pluginRepairName(info);
    if (restart && restart.ok && restart.noService) {
      /* 无常驻服务（remotion / 桌宠）：能重跑就直接重跑，否则只告诉用户可以重试一次
         （文案不写「重新生成」：桌宠这类插件没有生成动作） */
      toast(
        restart.reran
          ? name + " " + I18n.t("修复完成（该插件无常驻服务，已重跑该节点）")
          : name + " " + I18n.t("修复完成，可直接重试（该插件无常驻服务）"),
        "ok",
      );
    } else if (restart && restart.ok) {
      toast(name + " " + I18n.t("服务已重启"), "ok");
    } else if (restart && restart.note === "unknown_plugin") {
      /* 表里没有这个插件（窗口类插件 / 新宿主）：说清「没自动重启」，而不是吓人的「失败」 */
      toast(
        name + " " + I18n.t("修复完成（该插件没有登记的服务重启入口，请在插件卡片里手动启动）"),
        "ok",
      );
    } else {
      /* 重启失败只 toast：修是真修好了，只是拉不起来 —— 再弹窗就又成环了 */
      toast(
        name + " " + I18n.t("修复完成，但服务重启失败：") + ((restart && (restart.error || restart.note)) || I18n.t("未知错误")),
        "err",
      );
    }
    pluginRepairRefreshCard(pluginRepairServiceOf(info));
    pluginRepairRefreshNode(info);
  } else {
    /* 收敛闸门（二）：失败 / 被终止只再弹一次报告窗（附结论与 reason），窗内没有自动修复按钮。
       这里不 toast —— 窗本身就是收口，只有窗挤不进去时（ShowWhenIdle 的 onDrop）才补一行。 */
    pluginRepairShowResultReport(info, verdict);
  }

  if (typeof persistAgentSession === "function") {
    try {
      await persistAgentSession();
    } catch (_) {}
  }
}

/* ── 入口：主进程推来的插件错误 ── */
function pluginRepairHandleError(raw) {
  let info;
  try {
    info = pluginRepairNormalize(raw);
  } catch (_) {
    return;
  }
  if (!info.pluginId && !info.pluginName && !info.message && !info.log && !info.code) return;
  const key = pluginRepairKey(info);
  const now = Date.now();
  const last = _pluginRepairSeen.get(key) || 0;
  if (now - last < PLUGIN_REPAIR_DUP_MS) return; /* 同一条错误正在被处理 / 刚弹过 */
  _pluginRepairSeen.set(key, now);
  if (_pluginRepairSeen.size > 60) {
    const oldest = _pluginRepairSeen.keys().next();
    if (!oldest.done) _pluginRepairSeen.delete(oldest.value);
  }
  if (pluginRepairOverlayBusy()) {
    pluginRepairEnqueue(info);
    return;
  }
  openPluginRepairDialog(info);
}

/* 全局监听：不等插件对话框打开 —— 启动即订阅，报错来自哪个插件、哪条链都接得住 */
(function pluginRepairInit() {
  if (typeof window === "undefined") return;
  window.openPluginRepairDialog = openPluginRepairDialog;
  window.openPluginRepairResultDialog = openPluginRepairResultDialog;
  window.pluginRepairHandleError = pluginRepairHandleError;
  /* 收尾三件套挂出去：插件控制台 / 其它入口自己发起的修复也能复用同一份「判定→重启→刷新」 */
  window.pluginRepairJudge = pluginRepairJudge;
  window.pluginRepairRestartService = pluginRepairRestartService;
  window.pluginRepairShowResultReport = pluginRepairShowResultReport;
  window.pluginRepairClaimAuto = pluginRepairClaimAuto;
  try {
    if (window.api && typeof window.api.onPluginRepairError === "function") {
      window.api.onPluginRepairError(pluginRepairHandleError);
    }
  } catch (e) {
    console.error("pluginRepair init failed:", e);
  }
})();
