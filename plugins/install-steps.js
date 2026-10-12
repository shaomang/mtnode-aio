"use strict";
/**
 * 安装步骤**协议与模型**（纯函数，无 Electron 依赖）：
 * 8 个插件宿主 + 安装窗 + 冒烟测试共用一份口径，谁都不许在自己那边再抄一遍。
 *
 * 两份真源：
 *   1. 各包的 `steps.json`（步骤清单：id / 标题 / 是否可选 + **按错误码的失败文案表**）
 *      —— 开窗就列全表，未跑到的显示「待执行」；
 *   2. 各包 install 脚本 stdout 里的一行 JSON（`{"mtnodeStep":1,...}`，协议见 pack-steps/step.ps1）
 *      —— 每一步的 run / ok / fail / skip 与逐步日志。
 *
 * 为什么失败文案表在 steps.json 而不是脚本里：安装脚本必须**纯 ASCII**（PS 5.1 在中文
 * Windows 上按 ANSI 解码无 BOM 的 .ps1，中文会把语法解崩，见 test/smoke-install-scripts.js），
 * 而 steps.json 是 JSON、由 Node 按 UTF-8 读，不受这条限制。所以脚本只打稳定错误码 +
 * 动态参数（`{"code":"h3.venv.pip_failed","params":{"tail":"..."}}`），中文（或任何语言）
 * 的失败原因与处置建议全在 steps.json 的 `messages` 表里，由本模块与安装窗解析。
 *
 * 宿主只做两件事：把脚本 stdout 的每一行丢给 `parseStepLine`，认出来的转发、认不出的当日志。
 * 状态机只在本模块（`applyStep` / `finishSnapshot`），安装窗不自己判成败。
 */

/** 步骤行协议版本；脚本里 mtnodeStep 不是这个数一律不认（防把别的 JSON 日志误当步骤）。 */
const STEP_PROTOCOL = 1;

/** 步骤 id：脚本里手写，必须与 steps.json 一致。 */
const ID_RE = /^[A-Za-z0-9_.-]{1,48}$/;

/** 合法的步骤状态。 */
const STATUSES = ["pending", "run", "ok", "fail", "skip"];

/** 一条步骤行里允许携带的动态参数：键必须是标识符，值一律当字符串。 */
const PARAM_KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
/** 单个参数值 / 整条文案的长度上限（防脚本打个几 MB 的东西进来）。 */
const PARAM_MAX = 200;
const PARAM_TAIL_MAX = 600;
const MSG_MAX = 4000;
/** 一张文案表最多认多少条（正常一包不超过几十条）。 */
const MSG_TABLE_MAX = 40;

/** 文案里的语言表：{ text: { zh, en } }；两语至少有一条。 */
function normMsgTable(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  let n = 0;
  for (const [code, v] of Object.entries(raw)) {
    if (n >= MSG_TABLE_MAX) break;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(code)) continue;
    if (!v || typeof v !== "object") continue;
    const zh = String(v.zh == null ? "" : v.zh).trim();
    const en = String(v.en == null ? "" : v.en).trim();
    if (!zh && !en) continue;
    out[code] = { zh, en };
    n++;
  }
  return out;
}

/**
 * 把「错误码 + 动态参数 + 文案表」渲染成一句话。
 *   · locale 命中就用该语言，缺该语言回退另一语言；
 *   · 表里没有这一条 → 回空串（调用方退回脚本自己打的英文 message）。
 * `{key}` 占位替换 params[key]；`{tail}`（子脚本报错尾部）额外加一个可读前缀。
 */
function renderMsg(text, params, locale) {
  const t = text && typeof text === "object" ? text : { zh: String(text || ""), en: "" };
  const zh = locale !== "en";
  let s = String((zh ? t.zh || t.en : t.en || t.zh) || "");
  if (!s) return "";
  const p = params && typeof params === "object" ? params : {};
  const tail = String(p.tail == null ? "" : p.tail).trim();
  let usedTail = false;
  s = s.replace(/\{([A-Za-z0-9_]{1,32})\}/g, (m, k) => {
    if (k === "tail") {
      usedTail = true;
      if (!tail) return "";
      return (zh ? " ｜ 报错尾部：" : " | error tail: ") + tail;
    }
    return p[k] == null ? m : String(p[k]);
  });
  /* 模板没写 {tail} 时照样附上子脚本报错尾部：那是排障的原始证据，动态拼接、不进文案表 */
  if (tail && !usedTail) s += (zh ? " ｜ 报错尾部：" : " | error tail: ") + tail;
  return s.replace(/\s+/g, " ").trim().slice(0, MSG_MAX);
}

/**
 * 把一条失败步骤行渲染成文案（安装窗 / 「交给会话修复」共用同一口径）。
 * 表里查不到（老包 / 老脚本）就回空串，调用方用 step.message。
 */
function stepErrorText(step, locale) {
  const s = step || {};
  if (!s.code) return "";
  const table = s.messages && s.messages[s.code] ? s.messages : null;
  if (!table) return "";
  return renderMsg(table[s.code], s.params, locale);
}

/**
 * 从一行 stdout 里认出步骤行。
 * 返回 { step: {id, title, status, pct, message} } 或 null（null = 这是普通日志行）。
 * 认不出的原因一律静默：脚本会打各种 JSON 形态的日志，误报比漏报更糟。
 */
function parseStepLine(line) {
  const raw = String(line == null ? "" : line).trim();
  if (!raw || raw[0] !== "{" || raw[raw.length - 1] !== "}") return null;
  if (raw.indexOf("mtnodeStep") < 0) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (Number(obj.mtnodeStep) !== STEP_PROTOCOL) return null;
  const id = String(obj.id || "").trim();
  if (!ID_RE.test(id)) return null;
  const status = String(obj.status || "").trim().toLowerCase();
  if (status !== "run" && status !== "ok" && status !== "fail" && status !== "skip") return null;
  const out = { id, status };
  const title = String(obj.title || "").trim();
  if (title) out.title = title.slice(0, 120);
  const message = String(obj.message == null ? "" : obj.message).trim();
  if (message) out.message = message.slice(0, 4000);
  /* 稳定错误码 + 动态参数：脚本纯 ASCII，人类可读的失败文案按 code 从 steps.json 查表。 */
  const code = String(obj.code == null ? "" : obj.code).trim();
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(code)) out.code = code;
  const rawParams = obj.params && typeof obj.params === "object" && !Array.isArray(obj.params) ? obj.params : null;
  if (rawParams) {
    const params = Object.create(null);
    let n = 0;
    for (const [k, v] of Object.entries(rawParams)) {
      if (n >= 12) break;
      if (!PARAM_KEY_RE.test(k)) continue;
      const sv = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
      if (!sv) continue;
      params[k] = sv.slice(0, k === "tail" ? PARAM_TAIL_MAX : PARAM_MAX);
      n++;
    }
    if (Object.keys(params).length) out.params = params;
  }
  const pct = Number(obj.pct);
  if (Number.isFinite(pct)) out.pct = Math.max(0, Math.min(100, Math.round(pct)));
  return { step: out };
}

/** 读一份 steps.json 的正规形状：{ steps: [{ id, title, optional?, hint?, messages? }] }。
 *  messages 是「错误码 → { zh, en }」的失败文案表（脚本纯 ASCII，中文文案放这儿）。 */
function normManifest(raw) {
  const list = raw && Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw) ? raw : [];
  const seen = Object.create(null);
  const steps = [];
  for (const it of list) {
    if (!it) continue;
    const id = String(it.id || "").trim();
    if (!ID_RE.test(id) || seen[id]) continue;
    seen[id] = true;
    const messages = normMsgTable(it.messages);
    const step = {
      id,
      title: String(it.title || id).trim().slice(0, 120),
      optional: !!it.optional,
      hint: String(it.hint || "").trim().slice(0, 500),
    };
    if (Object.keys(messages).length) step.messages = messages;
    steps.push(step);
  }
  return { version: 1, steps };
}

/**
 * 新建一份会话快照。
 * meta: { id, name, installDir, skillName, steps: steps.json 的 steps[], action, startedAt }
 * 快照整份带着 steps 条目（含 messages 文案表），渲染层 / 装配「交给会话修复」的载荷
 * 都能按错误码解析出本地化文案。
 */
function createSnapshot(meta) {
  const m = meta || {};
  const manifest = Array.isArray(m.steps) ? m.steps : [];
  const steps = manifest.map((s) => {
    const row = {
      id: s.id,
      title: s.title || s.id,
      optional: !!s.optional,
      hint: s.hint || "",
      status: "pending",
      pct: null,
      message: "",
      startedAt: 0,
      endedAt: 0,
    };
    if (s.messages && Object.keys(s.messages).length) row.messages = s.messages;
    return row;
  });
  /* 按 id 的文案表索引：脚本打了一个清单里没有的 id（脚本比清单可信）时，也能查文案。
     渲染层与主进程共用它；没有文案表的包为空对象。 */
  const messagesById = Object.create(null);
  for (const s of manifest) {
    if (s && s.id && s.messages && Object.keys(s.messages).length) messagesById[s.id] = s.messages;
  }
  return {
    pluginId: String(m.id || ""),
    name: String(m.name || m.id || ""),
    installDir: String(m.installDir || ""),
    skillName: String(m.skillName || ""),
    action: String(m.action || "install"),
    startedAt: Number(m.startedAt) || Date.now(),
    endedAt: 0,
    /* idle = 窗开了、安装还没跑（等用户点「开始安装」）。脚本打第一条步骤行才转 running —— 
       否则窗一开就显示「安装中…」，用户看到的与事实不符。
       终局三态：done / failed / cancelled（cancelled = 用户主动终止，界面不按失败渲染）。 */
    state: "idle",
    pct: 0,
    error: "",
    hint: "",
    steps,
    messagesById,
    logs: Object.create(null),
    /* 日志序号游标：每行日志 +1（pushLog 维护）。「全部」视图按它还原真实输出顺序，
       分桶只负责「这一行属于哪一步」。 */
    logSeq: 0,
  };
}

/** 兼容落盘的日志体积上限：一步最多留 200KB（超大日志按尾部截断）。 */
const STEP_LOG_MAX = 200 * 1024;

function pushLog(snap, stepId, line) {
  if (!snap || !line) return { ok: false };
  const key = String(stepId || "_");
  const text = String(line).replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "");
  if (!text) return { ok: false };
  const logs = snap.logs || (snap.logs = Object.create(null));
  const prev = logs[key] || "";
  const next = prev ? prev + "\n" + text : text;
  logs[key] = next.length > STEP_LOG_MAX ? next.slice(next.length - STEP_LOG_MAX) : next;
  /* seq = 这行在**整场安装**里的序号（不是每一步的序号）。日志按步分桶存，
     但「全部」视图要按真实输出顺序读：安装窗靠它给每行排队（内存里，不落盘）。
     分桶的顺序不再是唯一信息 —— stepId 与 seq 一起回来，窗就能把「哪一步的、第几行」还原出来。 */
  const seq = (Number(snap.logSeq) || 0) + 1;
  snap.logSeq = seq;
  return { ok: true, seq };
}

/** 当前「进行中」的步骤 id：没有正在跑的步骤时返回最后一个已开始的步骤（未声明 id 的日志归到它）。 */
function currentStepId(snap) {
  if (!snap || !Array.isArray(snap.steps)) return "_";
  for (let i = snap.steps.length - 1; i >= 0; i--) {
    if (snap.steps[i].status === "run") return snap.steps[i].id;
  }
  return "_";
}

/**
 * 把一条步骤行落到快照上。返回 { ok, changed, stepIndex }。
 * 口径：
 *   · 清单里没有的 id → 追加到末尾（脚本永远比清单可信，绝不丢步骤）；
 *   · status="run" → 该步进入「进行中」，此前的 pending 步保持 pending（顺序执行，不自动补票）；
 *   · status="fail" → 该步失败，**快照整体转失败**（state="failed"），后续步骤保持 pending；
 *     code + params 从该步自己的 messages 表（或 meta.steps 里同 id 的那条）解析成本地化文案，
 *     解析不出来就用脚本打的英文 message（老包 / 老脚本照旧）。
 *   · status="ok" → 该步完成，整体 pct 取该步 pct（没给按「第几步 / 共几步」折算）。
 */
function applyStep(snap, step) {
  if (!snap || !step) return { ok: false, changed: false, stepIndex: -1 };
  const st = String(step.status || "");
  if (STATUSES.indexOf(st) < 0 || st === "pending") return { ok: false, changed: false, stepIndex: -1 };
  let idx = snap.steps.findIndex((s) => s.id === step.id);
  if (idx < 0) {
    const declared = (snap.steps || []).find((s) => s && s.id === step.id);
    snap.steps.push({
      id: step.id,
      title: step.title || step.id,
      optional: false,
      hint: "",
      status: "pending",
      pct: null,
      message: "",
      startedAt: 0,
      endedAt: 0,
      messages: (declared && declared.messages) || Object.create(null),
    });
    idx = snap.steps.length - 1;
    /* 清单里没有的 id 也要能查文案表：安装窗开窗时把 steps.json 的整表挂在 snap.messagesById 上 */
    if (snap.messagesById && snap.messagesById[step.id]) snap.steps[idx].messages = snap.messagesById[step.id];
  }
  const target = snap.steps[idx];
  if (step.title) target.title = step.title;
  if (step.message) target.message = step.message;
  if (step.code) target.code = step.code;
  if (step.params) target.params = step.params;
  const localText = stepErrorText(target, "zh");
  if (localText) target.messageText = localText;
  const now = Date.now();
  if (st === "run") {
    if (target.status !== "run") target.startedAt = now;
    target.status = "run";
    /* 前面还没跑到的步骤不算失败也不算跳过：并行/分支脚本可能不按清单顺序，保持 pending */
    if (snap.state === "failed") return { ok: true, changed: true, stepIndex: idx };
    snap.state = "running";
  } else if (st === "ok") {
    if (!target.startedAt) target.startedAt = now;
    target.status = "ok";
    target.endedAt = now;
    if (Number.isFinite(step.pct)) target.pct = step.pct;
  } else if (st === "skip") {
    target.status = "skip";
    target.endedAt = now;
  } else if (st === "fail") {
    target.status = "fail";
    target.endedAt = now;
    snap.state = "failed";
    snap.error = target.messageText || step.message || target.message || "";
  }
  /* 整体百分比：优先脚本给的 pct；没给就按已完成步数折算（可选步跳过也算完成） */
  let pct = Number.isFinite(step.pct) ? step.pct : null;
  if (pct == null && (st === "ok" || st === "skip")) {
    const done = snap.steps.filter((s) => s.status === "ok" || s.status === "skip").length;
    pct = snap.steps.length ? Math.round((100 * done) / snap.steps.length) : 0;
  }
  if (pct != null) snap.pct = Math.max(Number(snap.pct) || 0, pct);
  return { ok: true, changed: true, stepIndex: idx };
}

/**
 * 安装结束（宿主拿到终局结果时调用）：把没跑到的步骤按结局标掉。
 * outcome: { ok, error, hint, cancelled }
 *   · ok=true        → state="done"，仍 pending 的步骤标 skip
 *   · cancelled=true → state="cancelled"（用户主动终止，**不是**失败）：当前 run 的步标 fail，
 *                      仍 pending 的标 skip，error/hint 留空（界面按「已取消」文案渲染，
 *                      不把用户自己停的这一次当失败现场，也不弹报错报告）
 *   · 其余（ok=false）→ state="failed"：当前 run 的步标 fail；仍 pending 的保持 pending
 *                      （用户要看清「死在哪一步」）
 */
function finishSnapshot(snap, outcome) {
  if (!snap) return snap;
  const o = outcome || {};
  const now = Date.now();
  snap.endedAt = now;
  if (o.ok) {
    snap.state = "done";
    snap.pct = 100;
    for (const s of snap.steps) {
      if (s.status === "pending") {
        s.status = "skip";
        s.endedAt = now;
      }
    }
    return snap;
  }
  if (o.cancelled) {
    snap.state = "cancelled";
    for (const s of snap.steps) {
      if (s.status === "run") {
        s.status = "fail";
        s.endedAt = now;
        if (!s.message) s.message = "已取消";
      } else if (s.status === "pending") {
        s.status = "skip";
        s.endedAt = now;
      }
    }
    snap.error = String(o.error || "cancelled");
    snap.hint = String(o.hint || "");
    return snap;
  }
  snap.state = "failed";
  snap.error = String(o.error || snap.error || "");
  snap.hint = String(o.hint || snap.hint || "");
  for (const s of snap.steps) {
    if (s.status === "run") {
      s.status = "fail";
      s.endedAt = now;
      if (!snap.error) snap.error = s.messageText || s.message || "";
    }
  }
  return snap;
}

/** 一串日志里的最后若干行（安装窗失败时的「日志尾部」用）。 */
function tailLines(text, n) {
  const lines = String(text || "").split(/\r?\n/);
  const k = Math.max(1, Number(n) || 20);
  return lines.slice(Math.max(0, lines.length - k)).join("\n");
}

module.exports = {
  STEP_PROTOCOL,
  ID_RE,
  STATUSES,
  STEP_LOG_MAX,
  parseStepLine,
  normManifest,
  normMsgTable,
  renderMsg,
  stepErrorText,
  createSnapshot,
  applyStep,
  pushLog,
  currentStepId,
  finishSnapshot,
  tailLines,
};
