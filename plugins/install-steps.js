"use strict";
/**
 * 安装步骤**协议与模型**（纯函数，无 Electron 依赖）：
 * 8 个插件宿主 + 安装窗 + 冒烟测试共用一份口径，谁都不许在自己那边再抄一遍。
 *
 * 两份真源：
 *   1. 各包的 `steps.json`（步骤清单：id / 标题 / 是否可选）—— 开窗就列全表，未跑到的显示「待执行」；
 *   2. 各包 install 脚本 stdout 里的一行 JSON（`{"mtnodeStep":1,...}`，协议见 pack-steps/step.ps1）
 *      —— 每一步的 run / ok / fail / skip 与逐步日志。
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
  const pct = Number(obj.pct);
  if (Number.isFinite(pct)) out.pct = Math.max(0, Math.min(100, Math.round(pct)));
  return { step: out };
}

/** 读一份 steps.json 的正规形状：{ steps: [{ id, title, optional?, hint? }] }。 */
function normManifest(raw) {
  const list = raw && Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw) ? raw : [];
  const seen = Object.create(null);
  const steps = [];
  for (const it of list) {
    if (!it) continue;
    const id = String(it.id || "").trim();
    if (!ID_RE.test(id) || seen[id]) continue;
    seen[id] = true;
    steps.push({
      id,
      title: String(it.title || id).trim().slice(0, 120),
      optional: !!it.optional,
      hint: String(it.hint || "").trim().slice(0, 500),
    });
  }
  return { version: 1, steps };
}

/**
 * 新建一份会话快照。
 * meta: { id, name, installDir, skillName, steps: steps.json 的 steps[], action, startedAt }
 */
function createSnapshot(meta) {
  const m = meta || {};
  const manifest = Array.isArray(m.steps) ? m.steps : [];
  const steps = manifest.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    optional: !!s.optional,
    hint: s.hint || "",
    status: "pending",
    pct: null,
    message: "",
    startedAt: 0,
    endedAt: 0,
  }));
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
 *   · status="ok" → 该步完成，整体 pct 取该步 pct（没给按「第几步 / 共几步」折算）。
 */
function applyStep(snap, step) {
  if (!snap || !step) return { ok: false, changed: false, stepIndex: -1 };
  const st = String(step.status || "");
  if (STATUSES.indexOf(st) < 0 || st === "pending") return { ok: false, changed: false, stepIndex: -1 };
  let idx = snap.steps.findIndex((s) => s.id === step.id);
  if (idx < 0) {
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
    });
    idx = snap.steps.length - 1;
  }
  const target = snap.steps[idx];
  if (step.title) target.title = step.title;
  if (step.message) target.message = step.message;
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
    snap.error = step.message || target.message || "";
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
      if (!snap.error) snap.error = s.message || "";
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
  createSnapshot,
  applyStep,
  pushLog,
  currentStepId,
  finishSnapshot,
  tailLines,
};
