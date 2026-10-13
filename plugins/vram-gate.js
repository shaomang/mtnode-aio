"use strict";
/**
 * 插件的显存门槛（本轮需求：显存不够的本地后端插件对用户**直接隐藏**，
 * 避免新装的人装完才发现跑不起来）。
 *
 * 口径（用户共识，改动前先回读这一节）：
 *   · 名单与门槛只在这里一份：sensenova-local 24G · minimax-music3 24G ·
 *     yue2-local 16G · minimax-h3 16G（H3 由用户后续追加，门槛 16G）。
 *   · 比较的是**读数**：读得到显卡显存（nvidia-smi，多卡取最大那张）且最大显存 < 门槛 → 不达标。
 *     读不到（无 N 卡 / nvidia-smi 缺失 / 输出为空 / 数值为 null）→ **一律按「没超」处理**，
 *     照常显示插件：探测失败不是「显存不足」，不许拿它当隐藏理由。
 *   · 「已装就保留」：已装（磁盘上 .install-ok / 安装目录真有东西 / 窗口插件 installed.json）
 *     的插件即使显存不达标也照常显示（用户要能进它的控制台、要能卸载），只是界面上标注一句。
 *
 * 分工：本模块只算「该不该藏 + 为什么」，不碰目录过滤、不碰 IPC、不读 Electron。
 *   主进程侧 plugins/main-app-plugins.js 用它给目录条目挂 vram 元数据；渲染层照元数据过滤。
 *   显存读数走注入的 readGpu（生产 = perf-probe.js 的 nvidia-smi 采样器），便于冒烟替身。
 *
 * 缓存：插件对话框每次打开都会重拉目录，显存读数不能每拉一次 spawn 一次 nvidia-smi ——
 *   默认 20s TTL；量不到的结果同样缓存（否则每次都要等一次 6s 超时的子进程）。
 */

const fs = require("fs");
const path = require("path");

/** 插件 id（目录 id，不是 kind）→ 最低显存（GB）。单一真源，别在别处再抄一份。 */
const PLUGIN_VRAM_GB = {
  "sensenova-local": 24,
  "minimax-music3": 24,
  "yue2-local": 16,
  "minimax-h3": 16,
};

/** 默认读数缓存 TTL（毫秒）。 */
const VRAM_TTL_MS = 20000;

/** 已装判据的文件：安装目录里有它就当「这台机器上装过」 */
const READY_MARKERS = [".install-ok", ".venv", "ComfyUI", "node_modules", "models", ".scaffold-ref"];

const asNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function minVramGbOf(id) {
  const v = asNum(PLUGIN_VRAM_GB[String(id || "")]);
  return v && v > 0 ? v : 0;
}

function hasRequirement(id) {
  return minVramGbOf(id) > 0;
}

/**
 * 显卡读数的三种状态（**别把 unknown 与 unsupported 合并**）：
 *   { state:"ok", vramGb }           读到了：最大一张卡的显存总量（GB，保留一位小数）
 *   { state:"unknown", reason }      读不到：无 N 卡 / nvidia-smi 不可用 / 输出为空 / 数值为 null
 *   { state:"unsupported", vramGb }  保留位（当前判定不产出它，留作外部显式传参用）
 */
function gpuStateOf(gpu) {
  const cards = (gpu && Array.isArray(gpu.cards) ? gpu.cards : []).filter(Boolean);
  let best = null;
  for (const c of cards) {
    const mb = asNum(c.totalMb);
    if (mb == null || mb <= 0) continue;
    if (best == null || mb > best) best = mb;
  }
  if (best == null) {
    const why =
      (gpu && gpu.available === false && gpu.reason) ||
      (!cards.length ? "没有可用的显卡读数" : "显存数值读不到");
    return { state: "unknown", reason: String(why || "显存读数不可用") };
  }
  return { state: "ok", vramGb: Math.round((best / 1024) * 10) / 10 };
}

/**
 * 磁盘上的「这个插件的安装目录真的有东西」判据。
 * dir 空 / 不存在 → false；装了（有 READY_MARKERS 之一，或目录非空）→ true。
 * 只读，绝不建目录（只读入口不许有副作用 —— 与 plugin-root.js 同一纪律）。
 */
function dirLooksInstalled(dir) {
  const p = String(dir || "").trim();
  if (!p) return false;
  try {
    if (!fs.existsSync(p)) return false;
    for (const m of READY_MARKERS) {
      try {
        if (fs.existsSync(path.join(p, m))) return true;
      } catch {}
    }
    const list = fs.readdirSync(p);
    return list.length > 0;
  } catch {
    return false;
  }
}

/**
 * 建一个显存门槛判定器。
 * opts:
 *   readGpu       async () => { available, reason, cards:[{name,totalMb,...}] }（缺省 = 量不到）
 *   isInstalled   (rawPlugin) => bool  该插件在这台机器上是否已装（由调用方注入，本模块不认目录口径）
 *   ttlMs         读数缓存 TTL（缺省 20000；<=0 = 不缓存）
 *   now           () => number（冒烟用来拨表）
 */
function createVramGate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const readGpu = typeof o.readGpu === "function" ? o.readGpu : async () => ({ available: false, cards: [] });
  const isInstalled = typeof o.isInstalled === "function" ? o.isInstalled : () => false;
  const ttlMs = asNum(o.ttlMs) == null ? VRAM_TTL_MS : Number(o.ttlMs);
  const now = typeof o.now === "function" ? o.now : Date.now;
  let cache = null; /* { at, state } */

  /** 显存读数（带 TTL 缓存；量不到也缓存，避免反复等 nvidia-smi 超时） */
  async function vramState(force) {
    const t = now();
    if (!force && cache && ttlMs > 0 && t - cache.at < ttlMs) return cache.state;
    let state = null;
    try {
      state = gpuStateOf(await readGpu());
    } catch (e) {
      state = { state: "unknown", reason: String((e && e.message) || e || "读显存失败") };
    }
    cache = { at: t, state };
    return state;
  }

  /** 丢缓存（用户点「刷新目录」/ 安装完成后想立刻重判时用） */
  function invalidate() {
    cache = null;
  }

  /**
   * 一个插件的完整判定（渲染层只吃这一份）：
   *   { id, minVramGb, required, vram: {state, vramGb?, reason?}, installed, vramOk, hide, notice }
   *   vramOk = 这台机器的显存够不够（读不到 / 没门槛 / 已装 一律 true）
   *   hide   = 因此该不该从列表里藏掉（只有「有门槛 + 读到 + 不够 + 没装」才 true）
   *   notice = 显存不达标但又必须显示时给用户的那一句（空串 = 不显示）
   */
  async function stateOf(raw) {
    const id = String((raw && raw.id) || "");
    const minVramGb = minVramGbOf(id);
    const required = minVramGb > 0;
    const vram = await vramState(false);
    const installed = required ? !!isInstalled(raw) : false;
    let enough = true;
    let reason = "";
    if (required && vram.state === "ok" && asNum(vram.vramGb) != null && vram.vramGb < minVramGb) {
      enough = false;
      reason = "vram_low";
    }
    return {
      id,
      minVramGb,
      required,
      vram,
      installed,
      vramOk: enough,
      hide: required && !enough && !installed,
      notice: required && !enough && installed ? "本机显存可能不足" : "",
    };
  }

  return {
    version: 1,
    ttlMs,
    minVramGbOf,
    hasRequirement,
    vramState,
    invalidate,
    stateOf,
  };
}

module.exports = {
  PLUGIN_VRAM_GB,
  VRAM_TTL_MS,
  READY_MARKERS,
  minVramGbOf,
  hasRequirement,
  gpuStateOf,
  dirLooksInstalled,
  createVramGate,
};
