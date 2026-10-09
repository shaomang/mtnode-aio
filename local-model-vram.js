"use strict";
/**
 * 本地模型显存释放的**唯一编排器**（主进程侧，零依赖 · CommonJS）。
 *
 * 为什么需要它：本地模型后端各自独占同一张卡，历史上「上一个后端没把显存还回去 →
 * 下一个后端加载失败 / 卡死」全靠用户手动去各插件控制台点「停止后端」。minimax H3
 * 连续运行偶发卡死就属于这一类（上一单的 DiT/VAE 与残留张量还挂在卡上，第二次提交时
 * 显存不够又不敢报错，看起来就是卡住）。
 *
 * 本轮登记的五个后端（就是「本地模型」那五个，也是界面上有独立后端的那五个）：
 *   h3（ComfyUI 视频 / 超分 / 补帧）· music3 · yue（YuE2）· sensenova（本机出图）·
 *   llama（本地大模型）。tts / breeze（语音）显存占用小、本轮明确不纳入 ——
 *   以后要收进来，只需在 main.js 的登记表里多写一行，本模块一个字不用改。
 *
 * 本模块只做三件事：
 *   ① 收各后端宿主登记进来的「释放回调」（宿主之间不互相 require，见下）；
 *   ② 按统一口径释放：先软（unload / 停空闲服务）→ 量一次显存校验 → 仍占着才硬（杀进程树）；
 *   ③ 把每一步写成可复核的日志（[vram] 前缀，写进主进程日志与各后端自己的 console.log）。
 *
 * 登记口径（宿主侧只在 registerXxxIpc 里调一次 vramRegister，模块不反向 require 宿主）：
 *   vramRegister({
 *     id, label, port, consoleLabel,
 *     isRunning()  → 后端进程 / 服务是否在跑
 *     isLoaded()   → 权重是否大概率还挂在显存里（可选；缺省 = isRunning()）
 *     isBusy()     → 自己有没有在途任务（可选；缺省 false）
 *     soft(reason) → 轻量释放：/free、空缓存、停空闲服务（**不得**改动 wantRunning 以外的副作用）
 *     hard(reason) → 硬释放：杀进程树（宿主的 stopBackend / forceKill 口径）
 *   })
 *
 * 释放语义（用户口径）：
 *   · 别人的后端：直接停掉空闲进程（最干净，不留碎片）；
 *   · 自己的后端（同一模型连跑第二次）：跑完先轻量卸载（/free、空缓存、停服务），
 *     下一单起跑前再卸一次 —— 上一轮的模型与残留绝不带进下一轮；
 *   · 正在跑别的任务：等它跑完再释放（最长 RELEASE_WAIT_BUSY_MS），超时 / 顶栏手动释放时
 *     就如实报「被占用」，**绝不打断别人的任务**，也绝不把这种失败算成本次运行失败。
 *
 * 调用方拿到的一定是回执（数组 [ReleaseStep]），不是异常：释放失败只在调用方提示，
 * 不许把生成任务本身判失败。全程上限 RELEASE_TOTAL_MS，量不到显存读数时保守执行、如实写「量不到」。
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/* 单后端软释放的观察窗口：够 /free 与 Gradio 收摊（不够就按「仍占着」升级硬释放） */
const RELEASE_SOFT_MS = 10000;
/* 整体上限：超过之后不再动手（剩下的如实写「已超时」，绝不无限等） */
const RELEASE_TOTAL_MS = 30000;
/* 等「别人正在跑的活」跑完的上限（运行前钩子用；超时如实报占用） */
const RELEASE_WAIT_BUSY_MS = 60000;
/* 硬释放后等显存回落 / 端口放掉的观察窗口 */
const HARD_VERIFY_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 后端登记表 ─────────────────────────────────────────────────────────── */
const registry = new Map();

/**
 * 登记一个本地模型后端的释放能力。
 * 幂等：同 id 重复登记以最后一次为准（宿主在 registerXxxIpc 里只会走一次）。
 */
function vramRegister(def) {
  const id = String((def && def.id) || "").trim();
  if (!id) return null;
  const prev = registry.get(id) || {};
  const next = Object.assign({}, prev, def, { id });
  const fn = (name, fb) =>
    typeof next[name] === "function" ? next[name] : typeof prev[name] === "function" ? prev[name] : fb;
  next.label = String(next.label || id);
  next.port = Number(next.port) || 0;
  next.isRunning = fn("isRunning", () => false);
  next.isLoaded = fn("isLoaded", () => !!next.isRunning());
  next.isBusy = fn("isBusy", () => false);
  next.soft = fn("soft", null);
  next.hard = fn("hard", null);
  registry.set(id, next);
  return id;
}

function vramList() {
  return Array.from(registry.values()).map((b) => ({ id: b.id, label: String(b.label || b.id) }));
}

/**
 * 已登记后端的监听端口（只读，给顶栏「性能」面板的端口连通性检测用）。
 * 宿主登记时没写 port 的后端不回（宁可少一项，也不编造端口号）。
 */
function vramPorts() {
  const out = [];
  for (const def of registry.values()) {
    const p = Number(def.port) || 0;
    if (p > 0 && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

/** 释放动作的能力分派（可单测的纯函数）：软 / 硬分别走哪条路 */
function planActions(def) {
  const out = { soft: null, hard: null };
  if (!def) return out;
  if (typeof def.soft === "function") out.soft = "soft";
  else if (typeof def.hard === "function") out.soft = "hard"; /* 没有轻量卸载口的后端（Gradio）：停空闲服务就是最轻的一步 */
  if (typeof def.hard === "function") out.hard = "hard";
  return out;
}

/* ── 日志 ─────────────────────────────────────────────────────────────── */
let getDataDir = null;
let logHook = null;

function setVramContext(opts) {
  const o = opts || {};
  if (typeof o.getDataDir === "function") getDataDir = o.getDataDir;
  if (typeof o.log === "function") logHook = o.log;
}

function dataDirOrEmpty() {
  try {
    return getDataDir ? String(getDataDir() || "") : "";
  } catch {
    return "";
  }
}

/** 统一日志：主进程侧 <数据目录>/vram-release.log + 该后端自己的 console.log（控制台窗里看得见） */
function vramLog(line, backend) {
  const text = "[vram] " + String(line || "");
  try {
    if (typeof logHook === "function") logHook(text);
  } catch {}
  const dir = dataDirOrEmpty();
  if (!dir) return;
  try {
    const p = path.join(dir, "vram-release.log");
    fs.appendFileSync(p, "[" + new Date().toISOString() + "] " + text + "\n", "utf8");
  } catch {}
  const sub = backend && backend.subdir ? String(backend.subdir) : "";
  if (sub) {
    try {
      const p = path.join(dir, sub, "console.log");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, "[" + new Date().toISOString() + "] " + text + "\n", "utf8");
    } catch {}
  }
}

/* ── 显存读数（nvidia-smi；取不到就如实「量不到」） ─────────────────────── */
function vramRead() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || "").trim().split(/\r?\n/)[0] || "";
        const p = line.split(",").map((s) => s.trim());
        if (p.length < 3) return resolve(null);
        const used = Number(p[1]);
        const total = Number(p[2]);
        if (!Number.isFinite(used) || !Number.isFinite(total)) return resolve(null);
        resolve({ name: p[0], usedMb: used, totalMb: total });
      },
    );
  });
}

/* ── 超时包装：到点就当没成，绝不无限等（宿主某个 release 卡住不能拖死整个任务） ── */
function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, error: String((e && e.message) || e) }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "timeout", timeout: true }), ms);
      if (timer.unref) timer.unref();
    }),
  ]).then((r) => {
    if (timer) clearTimeout(timer);
    if (r && r.timeout && typeof onTimeout === "function") onTimeout();
    return r;
  });
}

/** 等到该后端空闲（没在途任务）或超时；返回 true = 已空闲 */
async function waitIdle(def, waitMs) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    let busy = false;
    try {
      busy = !!def.isBusy();
    } catch {
      busy = false;
    }
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

/**
 * 释放一个后端（主口径）。返回 ReleaseStep：
 *   { id, label, running, busy, action, ok, ms, reason, freedMb, skipped? }
 * action: "none"（没在跑，没动手）/ "soft" / "hard" / "busy"（别人在跑，等着呢）
 */
async function releaseOne(id, opts) {
  const o = opts || {};
  const def = registry.get(String(id || ""));
  if (!def) return { id: String(id || ""), label: String(id || ""), ok: false, action: "none", reason: "unregistered", ms: 0 };
  const t0 = Date.now();
  const reason = String(o.reason || "manual");
  let running = false;
  let busy = false;
  try {
    running = !!def.isRunning();
  } catch {}
  try {
    busy = !!def.isBusy();
  } catch {}
  /* 全局媒体锁记在**别人**的节点上 = 另一个本地模型任务正在进行（锁是在任何 await 之前占的，
     比各后端自己的在途标志更早、更可靠）：这时释放 = 直接打断别人的活，所以只如实报占用。 */
  const lockOwner = String(o.lockNodeId || "");
  const lockBusy = !!lockOwner && lockOwner !== String(o.jobNodeId || "__none__");
  if (lockBusy) busy = true;
  const step = {
    id: def.id,
    label: String(def.label || def.id),
    running,
    busy,
    action: "none",
    ok: true,
    ms: 0,
    reason: "",
    freedMb: null,
  };
  if (!running) {
    step.reason = "not_running";
    step.ms = Date.now() - t0;
    return step;
  }
  if (busy) {
    /* 手动（顶栏按钮）不等待：用户点一下就该有结果；运行前钩子才等「别人的活跑完」
       （waitBusyMs = 0 就是「看一眼忙不忙，忙就跳过」） */
    const idle = o.waitBusyMs > 0 ? await waitIdle(def, o.waitBusyMs) : false;
    if (!idle) {
      step.action = "busy";
      step.ok = false;
      step.reason = lockBusy ? "busy_by_other_job" : "busy";
      step.ms = Date.now() - t0;
      vramLog(
        "跳过 " +
          step.label +
          "：正在跑别的任务" +
          (lockBusy ? "（全局锁在节点 " + lockOwner + "）" : "") +
          (o.waitBusyMs > 0
            ? "（等了 " + Math.round((o.waitBusyMs || 0) / 1000) + "s 仍忙）"
            : "") +
          " —— 不打断它，等它自己跑完",
        def,
      );
      return step;
    }
  }

  const acts = planActions(def);
  const before = await vramRead();
  const seq = [];
  if (acts.soft) seq.push("soft");
  if (acts.hard && (!acts.soft || o.escalate !== false)) seq.push("hard");

  for (let i = 0; i < seq.length; i++) {
    const act = seq[i];
    if (o.deadline && Date.now() > o.deadline) {
      step.reason = step.reason || "total_timeout";
      vramLog("" + step.label + " 未处理：本次释放已到总上限（" + RELEASE_TOTAL_MS + "ms）", def);
      break;
    }
    /* 软释放已经让显存回落了 → 不做更重的硬释放（保住常驻服务：下次任务直接复用） */
    if (act === "hard" && step.action === "soft") {
      const mid = await vramRead();
      if (mid && before && before.usedMb - mid.usedMb >= 512) {
        vramLog(step.label + " 软释放后显存已回落 " + (before.usedMb - mid.usedMb) + "MB，保留常驻服务不再杀进程", def);
        break;
      }
    }
    step.action = act;
    const fn = act === "soft" ? def.soft : def.hard;
    vramLog((act === "soft" ? "软释放（卸载 / 停空闲服务）" : "硬释放（杀进程树）") + " " + step.label + " · reason=" + reason, def);
    const r = await withTimeout(
      (async () => fn.call(def, reason))(),
      act === "soft" ? RELEASE_SOFT_MS : RELEASE_SOFT_MS + HARD_VERIFY_MS,
      () => vramLog((act === "soft" ? "软释放" : "硬释放") + " " + step.label + " 超时（" + (act === "soft" ? RELEASE_SOFT_MS : RELEASE_SOFT_MS + HARD_VERIFY_MS) + "ms），按未完成继续", def),
    );
    if (!r.ok) {
      step.ok = false;
      step.reason = String(r.error || "error");
      vramLog("释放失败 " + step.label + "（" + act + "）：" + step.reason + " —— 释放失败不影响本次生成，下一步动作：" + (act === "soft" ? "若显存仍占着将升级为杀进程" : "下次任务会自行重新拉起后端"), def);
    }
    if (act === "soft") await sleep(600);
  }

  const after = await vramRead();
  if (before && after) {
    step.freedMb = before.usedMb - after.usedMb;
  } else {
    step.freedMb = null; /* 量不到读数：保守执行 + 如实写「量不到」 */
  }
  try {
    step.running = !!def.isRunning();
  } catch {}
  step.ms = Date.now() - t0;
  if (step.action === "none") step.reason = step.reason || "not_running";
  const freedTxt = step.freedMb == null ? "量不到" : (step.freedMb >= 0 ? "腾出 " : "增加 ") + Math.abs(step.freedMb) + "MB";
  vramLog(
    "完成 " + step.label + "：动作=" + step.action + " · " + freedTxt + " · 耗时 " + step.ms + "ms" + (step.ok ? "" : " · 有问题=" + step.reason),
    def,
  );
  return step;
}

/** 释放多个后端（顺序执行：同一张卡上并行释放只会互相打架） */
async function releaseMany(ids, opts) {
  const o = opts || {};
  const deadline = Date.now() + (Number(o.totalMs) > 0 ? Number(o.totalMs) : RELEASE_TOTAL_MS);
  const out = [];
  for (const id of ids) {
    out.push(await releaseOne(id, Object.assign({}, o, { deadline })));
  }
  return out;
}

/**
 * 运行前：释放「除了本次要用的后端以外」的全部本地后端。
 * except：本次要用的后端 id（"h3" / "music3" / "yue" / "sensenova" / "llama"）；
 * jobNodeId：本次任务的节点 id（用于认出全局媒体锁是不是自己占的）。
 */
async function releaseOthers(opts) {
  const o = opts || {};
  const except = String(o.except || "");
  const jobLock = typeof o.readJobLock === "function" ? safeCall(o.readJobLock) : null;
  const lockNode = String((jobLock && jobLock.nodeId) || "");
  const ownLock = !!lockNode && lockNode === String(o.jobNodeId || "__none__");
  const ids = [];
  for (const def of registry.values()) {
    if (def.id === except) continue;
    ids.push(def.id);
  }
  /* 不打断别人的活这条纪律由「后端自己的 isBusy()」把关（releaseOne 里等它跑完 / 超时如实报占用）：
     全局锁的 nodeId 这一刻可能还没写（钩子在取锁前后都可能跑），拿它当判据会误判成「别人在跑」
     而整轮不释放 —— 所以这里只用它记一条日志，不做跳过。 */
  if (lockNode && !ownLock) {
    await groupLog(
      "注意：全局媒体锁当前记在节点 " + lockNode + " 上（本节点 " + (o.jobNodeId || "?") + "）—— 逐个后端看它自己忙不忙，忙的等它跑完",
    );
  }
  if (!ids.length) return [];
  await groupLog("运行前释放其他本地模型：" + ids.map((i) => labelOf(i)).join("、") + "（本次要用 " + (labelOf(except) || "无") + "）");
  return releaseMany(ids, {
    reason: o.reason || "pre_run",
    lockNodeId: lockNode,
    jobNodeId: o.jobNodeId || "",
    waitBusyMs: Number(o.waitBusyMs) >= 0 ? Number(o.waitBusyMs) : RELEASE_WAIT_BUSY_MS,
    totalMs: Number(o.totalMs) > 0 ? Number(o.totalMs) : RELEASE_TOTAL_MS,
  });
}

/** 收尾：释放本次自己用过的后端（清掉这一轮的模型与残留，避免下一轮被上一轮占着）。
 *  收尾这一刻全局锁通常还在**自己**手上（节点在生成函数内部放锁），所以只等一小会儿
 *  （别人的活绝不动手；自己的残留清干净就走）。 */
async function releaseSelf(id, opts) {
  const o = opts || {};
  if (!id || !registry.has(String(id))) return [];
  const jobLock = typeof o.readJobLock === "function" ? safeCall(o.readJobLock) : null;
  const lockNode = String((jobLock && jobLock.nodeId) || "");
  await groupLog("本次运行收尾：释放 " + labelOf(id) + " 占用的显存（残留不带进下一轮）");
  return releaseMany([id], {
    reason: o.reason || "post_run",
    lockNodeId: lockNode,
    jobNodeId: o.jobNodeId || "",
    waitBusyMs: Number(o.waitBusyMs) >= 0 ? Number(o.waitBusyMs) : 15000,
    totalMs: Number(o.totalMs) > 0 ? Number(o.totalMs) : RELEASE_TOTAL_MS,
  });
}

function labelOf(id) {
  const d = registry.get(String(id || ""));
  return d ? String(d.label || d.id) : "";
}
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
async function groupLog(line) {
  vramLog(line, null);
}

/** 现况快照（顶栏按钮 / 面板）：谁在跑、谁占着显存、刚才释放了多少 */
async function vramSnapshot() {
  const gpu = await vramRead();
  const backends = [];
  for (const def of registry.values()) {
    let running = false;
    let busy = false;
    let loaded = false;
    try {
      running = !!def.isRunning();
    } catch {}
    try {
      busy = !!def.isBusy();
    } catch {}
    try {
      loaded = !!def.isLoaded();
    } catch {}
    backends.push({
      id: def.id,
      label: String(def.label || def.id),
      host: String(def.host || ""),
      port: Number(def.port) || 0,
      running,
      busy,
      loaded,
      /* 空闲（在跑但没任务）= 可安全释放 */
      idleReleasable: running && !busy,
    });
  }
  return {
    ok: true,
    gpu: gpu ? { name: gpu.name, usedMb: gpu.usedMb, totalMb: gpu.totalMb } : null,
    backends,
    log: tailLog(24),
  };
}

function tailLog(lines) {
  const dir = dataDirOrEmpty();
  if (!dir) return [];
  try {
    const p = path.join(dir, "vram-release.log");
    if (!fs.existsSync(p)) return [];
    const text = fs.readFileSync(p, "utf8");
    const all = text.split(/\r?\n/).filter(Boolean);
    return all.slice(-Math.max(1, Number(lines) || 20));
  } catch {
    return [];
  }
}

/* ── IPC 接线（main.js 调一次） ─────────────────────────────────────────── */
function registerVramIpc(opts) {
  const o = opts || {};
  setVramContext(o);
  const ipcMain = o.ipcMain || require("electron").ipcMain;
  const readJobLock = typeof o.readJobLock === "function" ? o.readJobLock : () => null;
  const onReleased = typeof o.onReleased === "function" ? o.onReleased : null;

  ipcMain.handle("vram:snapshot", async () => vramSnapshot());
  ipcMain.handle("vram:listBackends", async () => ({ ok: true, backends: vramList() }));
  ipcMain.handle("vram:release", async (e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const triggeredBy = String(p.triggeredBy || "manual");
    const lock = safeCall(readJobLock);
    const ids = Array.isArray(p.ids) && p.ids.length ? p.ids.map(String) : null;
    const except = String(p.except || "");
    const phase = String(p.phase || (except ? "pre_run" : "manual"));
    const jobNodeId = String(p.jobNodeId || p.nodeId || "");
    const lockNodeId = String((lock && lock.nodeId) || "");
    const base = { lockNodeId, jobNodeId, totalMs: RELEASE_TOTAL_MS };
    let steps = [];
    if (phase === "post_run" && ids && ids.length) {
      steps = await releaseMany(ids, Object.assign({}, base, { reason: "post_run", waitBusyMs: 15000 }));
    } else if (ids) {
      /* 顶栏按钮（manual）**不等待**：用户点一下就该有结果，忙的后端如实回「被占用」 */
      steps = await releaseMany(
        ids,
        Object.assign({}, base, {
          reason: phase,
          waitBusyMs: phase === "manual" ? 0 : RELEASE_WAIT_BUSY_MS,
        }),
      );
    } else {
      steps = await releaseOthers({ except, jobNodeId, reason: phase, readJobLock, waitBusyMs: RELEASE_WAIT_BUSY_MS });
    }
    const receipt = {
      ok: true,
      triggeredBy,
      phase,
      except,
      steps,
      gpu: await vramRead().then((g) => (g ? { name: g.name, usedMb: g.usedMb, totalMb: g.totalMb } : null)),
    };
    if (onReleased) {
      try {
        onReleased(receipt, lock);
      } catch {}
    }
    return receipt;
  });
}

module.exports = {
  RELEASE_SOFT_MS,
  RELEASE_TOTAL_MS,
  RELEASE_WAIT_BUSY_MS,
  vramRegister,
  vramList,
  vramPorts,
  vramSnapshot,
  vramRelease: releaseMany,
  vramReleaseOthers: releaseOthers,
  vramReleaseSelf: releaseSelf,
  vramRead,
  vramLog,
  planActions,
  setVramContext,
  registerVramIpc,
  tailLog,
};
