"use strict";
/**
 * 插件**安装后自检**的内核（主进程，唯一一处）。
 *
 * 需求（用户共识）：
 *   ① 插件装完后自动跑一次「最低档、最快」的自检 —— 真的生成一个对应类型的最小内容
 *      （图像 1 张最小桶 / 语音 1 句短文本 / 音乐最短时长 / 视频最小分辨率 + 最短时长 / 动效 1 帧）；
 *   ② 结果展示在**安装窗**里（状态 + 逐项明细 + 产物路径），另有「重新自检」与「清理自检产物」；
 *   ③ 结果按插件 id 落本机数据目录，主窗口插件界面的卡片据此在**封面左上角打勾**（只给自检通过的插件）。
 *
 * 分工（照本仓既有纪律）：
 *   · 本模块 = 注册表 + 结果落盘 + 等锁队列 + 产物目录 + 事件上报，**不含任何插件专属的生成逻辑**；
 *   · 各宿主（sensenova / breeze / music3 / yue / h3 / remotion）在 require 期
 *     `registerPluginSelfcheck({ id, key, label, check })` 登记自己的 `check`；
 *   · 安装窗的编排在同级的 main-install.js（本模块不碰窗口，只回状态、只往它推事件）；
 *   · 数据一律落 `<数据目录>/plugin-selfcheck/<id>.json` 与 `<...>/<id>/`（绝不落应用目录）。
 *
 * check(ctx) 契约（宿主侧）：
 *   ctx = {
 *     id,                       // 插件 id
 *     kind,                     // "image" | "speech" | "music" | "video" | "motion"
 *     dataDir,                  // 数据目录绝对路径
 *     installDir,               // 该插件的安装目录（可能为空串）
 *     artifactDir,              // 本次自检的产物目录（已建好，宿主把产物写这里）
 *     log(line),                // 一行明细（进安装窗日志区）
 *     sending(s),               // 「正在生成…」这类中间进度（可选）
 *     waitMediaLock(),          // 出片前等全局媒体锁空闲：{ok} | {ok:false,reason:"timeout"|"cancelled"|"busy"}
 *     signal: { aborted },      // 取消标记（用户点「取消自检」时为真）
 *   }
 *   返回 = { ok, skipped?, reason?, note?, warnings?, artifacts?: [{path,label}], steps?: [{id,title,status,detail}] }
 *     · ok:true            → 本次自检通过（卡片打勾）
 *     · skipped:true       → 没跑（缺工具 / 等锁超时 / 明确跳过），**不打勾**，如实展示原因
 *     · 抛异常              → 本模块兜成 ok:false + error 文本（失败不静默）
 */

const fs = require("fs");
const path = require("path");

const { refreshStaleLock, loadLock, busyMessage } = require("../media-gen-global-lock.js");

/** 等锁轮询间隔 / 排队上限（用户共识：自动排队，上限 30 分钟，超时如实标注「已跳过」） */
const QUEUE_POLL_MS = 5000;
const QUEUE_MAX_MS = 30 * 60 * 1000;
/** 自检硬超时：宿主自己也可能挂着（脚本 / 后端不响应），这里兜一层（默认 90 分钟） */
const CHECK_MAX_MS = 90 * 60 * 1000;

/** 已登记的插件自检：id → { id, key, label, kind, check } */
const registry = new Map();
/** 正在跑 / 刚跑完的自检任务现场：id → job */
const jobs = new Map();

let getDataDir = () => "";
let getInstallDirOf = () => "";
let pushEvent = () => false;
let logLine = () => {};
let notifyMain = () => false;

/* ------------------------------------------------------------------ */
/* 登记与路径                                                          */
/* ------------------------------------------------------------------ */

/** 宿主在 require 期登记自己的自检能力。重复登记以最后一次为准（热重载 / 重复 require 无害）。 */
function registerPluginSelfcheck(spec) {
  const s = spec || {};
  const id = String(s.id || "").trim();
  if (!id || typeof s.check !== "function") return { ok: false, error: "bad_spec" };
  registry.set(id, {
    id,
    key: String(s.key || id),
    label: String(s.label || id),
    kind: String(s.kind || ""),
    check: s.check,
  });
  return { ok: true };
}

/** 接线（可多次调用：只覆盖这一次真给的那几项，其余沿用上一次 —— 安装窗与主窗口各接一次，
 *  谁都不该把对方接好的口冲掉）。 */
function initPluginSelfcheck(opts) {
  const o = opts || {};
  if (typeof o.getDataDir === "function") getDataDir = o.getDataDir;
  if (typeof o.getInstallDirOf === "function") getInstallDirOf = o.getInstallDirOf;
  if (typeof o.pushEvent === "function") pushEvent = o.pushEvent;
  if (typeof o.log === "function") logLine = o.log;
  if (typeof o.notifyMain === "function") notifyMain = o.notifyMain;
  return { ok: true, registered: [...registry.keys()] };
}

/** 数据目录（取不到就回空串：调用方一律按「没结果」处理，绝不编造路径） */
function dataDirNow() {
  try {
    const d = typeof getDataDir === "function" ? getDataDir() : "";
    return typeof d === "string" && d ? d : "";
  } catch {
    return "";
  }
}

function rootDir() {
  const d = dataDirNow();
  return d ? path.join(d, "plugin-selfcheck") : "";
}

function resultPathOf(id) {
  const root = rootDir();
  return root ? path.join(root, encodeURIComponent(String(id || "_")) + ".json") : "";
}

function artifactRootOf(id) {
  const root = rootDir();
  return root ? path.join(root, encodeURIComponent(String(id || "_"))) : "";
}

/** 本次自检的产物目录（时间戳子目录，产物之间不互相覆盖） */
function newArtifactDir(id) {
  const base = artifactRootOf(id);
  if (!base) return "";
  const dir = path.join(base, "check-" + new Date().toISOString().replace(/[:.]/g, "-"));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return "";
  }
  return dir;
}

function installDirOf(id) {
  try {
    const d = typeof getInstallDirOf === "function" ? getInstallDirOf(id) : "";
    return typeof d === "string" ? d : "";
  } catch {
    return "";
  }
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 结果落盘 / 读回                                                     */
/* ------------------------------------------------------------------ */

/** 读某个插件的最近一次自检结果（没有 / 读不动 → null）。主窗口与安装窗都走它。 */
function readCheck(id) {
  const p = resultPathOf(id);
  if (!p) return null;
  const v = readJsonFile(p);
  return v && typeof v === "object" ? v : null;
}

function writeCheck(result) {
  const p = resultPathOf(result && result.id);
  if (!p) return null;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (e) {
    logLine("[selfcheck] write failed id=" + (result && result.id) + " err=" + ((e && e.message) || e));
  }
  return p;
}

/** 卡片打勾的唯一判据：最近一次自检**通过**（失败 / 跳过 / 没测过一律不打勾）。 */
function checkPassed(id) {
  const r = readCheck(id);
  return !!(r && r.ok === true && r.skipped !== true);
}

/**
 * 主窗口插件界面用的一份快照：哪些插件自检通过（打勾）+ 每个的最近一次结论摘要。
 * 没有登记的插件也照回（用户自建插件 / 窗口插件 / 桌宠不打勾）。
 */
function selfcheckSummary() {
  const out = {};
  for (const id of registry.keys()) {
    const r = readCheck(id);
    const job = jobs.get(id);
    out[id] = {
      registered: true,
      passed: !!(r && r.ok === true && r.skipped !== true),
      result: r,
      running: !!(job && job.running),
      queued: !!(job && job.queued),
    };
  }
  return { ok: true, dir: rootDir(), checks: out };
}

/* ------------------------------------------------------------------ */
/* 等全局媒体锁（出片类自检）                                          */
/* ------------------------------------------------------------------ */

/** 锁现在被别人占着吗？占着就回它的现场（没占 / 过期 → null）。 */
function mediaLockBusy() {
  const lock = refreshStaleLock() || loadLock();
  return lock && lock.nodeId ? lock : null;
}

/** 睡一会儿（不阻止进程退出；循环每轮都会重看取消标记，所以不必真打断定时器） */
function wait(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === "function") t.unref();
  });
}

/**
 * 等锁空闲：每 5s 看一眼，上限 30 分钟（用户共识）。
 * 回执：{ ok:true } / { ok:false, reason:"timeout"|"cancelled", lock }
 */
async function waitMediaLock(signal) {
  const started = Date.now();
  for (;;) {
    if (signal && signal.aborted) return { ok: false, reason: "cancelled" };
    const lock = mediaLockBusy();
    if (!lock) return { ok: true, waitedMs: Date.now() - started };
    if (Date.now() - started > QUEUE_MAX_MS) {
      return { ok: false, reason: "timeout", lock, message: busyMessage(lock) };
    }
    await wait(Math.min(QUEUE_POLL_MS, Math.max(500, QUEUE_MAX_MS - (Date.now() - started))));
  }
}

/* ------------------------------------------------------------------ */
/* 跑一次自检                                                          */
/* ------------------------------------------------------------------ */

function emit(id, payload) {
  try {
    pushEvent(Object.assign({ id, kind: "selfcheck" }, payload || {}));
  } catch {}
}

/** 结论变了就告诉主窗口一次：插件界面的勾角标据此重画（它不听安装窗那条事件流）。 */
function notifyChanged(id, result) {
  try {
    notifyMain({
      id: String(id || ""),
      passed: !!(result && result.ok === true && result.skipped !== true),
      at: (result && result.at) || Date.now(),
    });
  } catch {}
}

/** 把宿主抛出来的东西翻成一句人话（失败不静默，也不甩一个对象给界面） */
function errText(e) {
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  const m = e.message || e.error;
  return String(m || e);
}

function stepLine(sink, title, status, detail) {
  sink.step({ id: "step", title: String(title || ""), status: String(status || "run"), detail: detail == null ? "" : String(detail) });
}

/**
 * 跑（或复用正在跑的）一次自检。
 * opts: { reason: "auto"|"manual"|"install", installDir?: string }
 *   installDir 由安装窗把它手上那份现场带过来（各宿主也各自有配置兜底）——两处对不上时，
 *   以安装窗这一次的现场为准，避免「自检说没装好、安装窗说刚装完」这种自相矛盾。
 * 立即回执 { ok:true, started:true, running:true } 或 { ok:true, started:false, running:true }（已在跑）。
 */
function runCheck(id, opts) {
  const pid = String(id || "").trim();
  const o = opts || {};
  if (!pid) return { ok: false, error: "bad_id" };
  const reg = registry.get(pid);
  if (!reg) {
    return {
      ok: false,
      error: "no_selfcheck",
      message: "该插件没有登记内容生成类自检（只有生成类插件做自检）。",
    };
  }
  const cur = jobs.get(pid);
  if (cur && cur.running) return { ok: true, started: false, running: true, job: jobPublic(cur) };

  const job = {
    id: pid,
    startedAt: Date.now(),
    finishedAt: 0,
    running: true,
    queued: false,
    reason: String(o.reason || "manual"),
    aborted: false,
    note: "",
    result: null,
  };
  jobs.set(pid, job);
  emit(pid, { state: "run", reason: job.reason, startedAt: job.startedAt });

  const signal = {
    aborted: false,
    onAbort: null,
    abort() {
      this.aborted = true;
      if (typeof this.onAbort === "function") {
        try { this.onAbort(); } catch {}
      }
    },
  };
  job.signal = signal;
  const artifactDir = newArtifactDir(pid);
  const sink = {
    progress(note) {
      job.note = String(note || "");
      emit(pid, { state: "run", note: job.note, queued: false });
    },
    step(s) {
      emit(pid, { state: "run", step: s, note: job.note });
    },
    log(line) {
      const t = String(line == null ? "" : line);
      if (!t) return;
      emit(pid, { state: "run", log: t });
    },
    queued(lock) {
      job.queued = true;
      emit(pid, {
        state: "run",
        queued: true,
        note: "有其它生成任务进行中（全局仅允许 1 个），已排队等它结束…",
        lock: lock || null,
      });
    },
    unqueued() {
      job.queued = false;
    },
  };

  const ctx = {
    id: pid,
    key: reg.key,
    label: reg.label,
    kind: reg.kind,
    dataDir: dataDirNow(),
    /* 安装目录：安装窗带过来的现场优先（它写的就是「这次装到哪」），否则按主进程口径推 */
    installDir: String(o.installDir || "").trim() || installDirOf(pid),
    artifactDir,
    log: sink.log,
    step: sink.step,
    progress: sink.progress,
    signal,
    async waitMediaLock() {
      const lock = mediaLockBusy();
      if (!lock) return { ok: true, waitedMs: 0 };
      sink.queued(lock);
      const r = await waitMediaLock(signal);
      sink.unqueued();
      return r;
    },
  };

  const finish = (out) => {
    const res = Object.assign(
      {
        id: pid,
        key: reg.key,
        label: reg.label,
        kind: reg.kind,
        at: Date.now(),
        ok: false,
        skipped: false,
        artifacts: [],
        steps: [],
        warnings: [],
      },
      out && typeof out === "object" ? out : {},
    );
    res.id = pid;
    res.at = res.at || Date.now();
    res.installDir = res.installDir || ctx.installDir;
    res.artifactDir = res.artifactDir || artifactDir;
    if (!Array.isArray(res.artifacts)) res.artifacts = [];
    if (!Array.isArray(res.steps)) res.steps = [];
    if (!Array.isArray(res.warnings)) res.warnings = [];
    res.ok = res.ok === true && res.skipped !== true;
    writeCheck(res);
    job.running = false;
    job.queued = false;
    job.finishedAt = Date.now();
    job.result = res;
    emit(pid, { state: "done", result: res });
    notifyChanged(pid, res);
    logLine(
      "[selfcheck] id=" + pid + " ok=" + res.ok + (res.skipped ? " skipped=" + (res.reason || "") : "") +
        (res.error ? " err=" + String(res.error).slice(0, 200) : ""),
    );
    return res;
  };

  const timer = setTimeout(() => {
    if (job.running) signal.abort();
  }, CHECK_MAX_MS);
  if (timer && typeof timer.unref === "function") timer.unref();

  Promise.resolve()
    .then(() => reg.check(ctx))
    .then((out) => {
      clearTimeout(timer);
      return finish(out);
    })
    .catch((e) => {
      clearTimeout(timer);
      return finish({ ok: false, error: errText(e), skipped: signal.aborted });
    });

  return { ok: true, started: true, running: true };
}

function jobPublic(job) {
  return job
    ? { id: job.id, running: !!job.running, queued: !!job.queued, note: job.note, startedAt: job.startedAt }
    : null;
}

/** 取消一次自检：标记取消 + 通知宿主（宿主自己收手；产物目录留着，由用户点「清理」删）。 */
function cancelCheck(id) {
  const pid = String(id || "").trim();
  const job = jobs.get(pid);
  if (!job || !job.running) return { ok: true, cancelled: false };
  job.aborted = true;
  if (job.signal) job.signal.abort();
  emit(pid, { state: "run", note: "已请求取消（脚本 / 后端可能要几秒才收手）" });
  return { ok: true, cancelled: true };
}

/** 安装窗打开一个插件时的现场：登记能力 + 最近一次结果 + 正在跑 / 在排队。 */
function stateOf(id) {
  const pid = String(id || "").trim();
  const job = jobs.get(pid);
  return {
    ok: true,
    id: pid,
    supported: registry.has(pid),
    label: (registry.get(pid) || {}).label || "",
    kind: (registry.get(pid) || {}).kind || "",
    result: readCheck(pid),
    running: !!(job && job.running),
    queued: !!(job && job.queued),
    note: job ? job.note : "",
    artifactsExists: (() => {
      const d = artifactRootOf(pid);
      try {
        return !!(d && fs.existsSync(d));
      } catch {
        return false;
      }
    })(),
  };
}

/** 「清理自检产物」：删产物目录 + 清结果缓存（勾随之消失）。只动自检自己的目录，不碰安装目录。 */
function cleanArtifacts(id) {
  const pid = String(id || "").trim();
  const job = jobs.get(pid);
  if (job && job.running) return { ok: false, error: "running", message: "自检正在跑，等它结束或先取消再清理。" };
  const dir = artifactRootOf(pid);
  const file = resultPathOf(pid);
  let removed = 0;
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  } catch (e) {
    return { ok: false, error: "rm_failed", message: String((e && e.message) || e) };
  }
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  jobs.delete(pid);
  emit(pid, { state: "cleaned" });
  notifyChanged(pid, null);
  return { ok: true, removed };
}

/** 卸载插件时把它的自检结果与产物一并清掉（用户共识：卸载后勾与结果一起失效）。 */
function dropCheck(id) {
  const pid = String(id || "").trim();
  if (!pid) return { ok: false, error: "bad_id" };
  const job = jobs.get(pid);
  if (job && job.running && job.signal) job.signal.abort();
  jobs.delete(pid);
  try {
    const dir = artifactRootOf(pid);
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  try {
    const f = resultPathOf(pid);
    if (f && fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
  return { ok: true };
}

module.exports = {
  QUEUE_MAX_MS,
  QUEUE_POLL_MS,
  registerPluginSelfcheck,
  initPluginSelfcheck,
  runCheck,
  cancelCheck,
  stateOf,
  readCheck,
  checkPassed,
  selfcheckSummary,
  cleanArtifacts,
  dropCheck,
  /** 给宿主用的：出片前等锁（同一份口径，宿主不必自己再写一遍轮询） */
  waitMediaLock,
  mediaLockBusy,
  registry,
};
