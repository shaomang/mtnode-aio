"use strict";
/**
 * MOSS-TTS-Nano 推理设备探测（纯判定 + 一次 nvidia-smi 读数，零 Electron 依赖）。
 *
 * 为什么要它：这个后端内置但要首次按需装依赖，装的是 **CPU 版 onnxruntime 还是
 * onnxruntime-gpu** 完全取决于本机显卡；装错了要么白占几百 MB，要么一开机就报
 * CUDA 找不到 DLL。所以「装哪一版」必须在安装前就问清楚，而不是等运行期崩。
 *
 * 口径（本机实测，改动前先回读）：
 *   · 判 cuda 要四条同时成立：① 有 NVIDIA 卡；② 不是集显 / 核显 / 别家卡
 *     （Intel / AMD / UHD / Graphics / Radeon 一律 cpu —— onnxruntime 的 CUDA EP 只认 N 卡）；
 *     ③ 总显存 ≥ 6GB（MOSS-100M 实际只占几百 MB，这里取保守值，避免小显存卡上装 GPU 版反而更慢）；
 *     ④ 驱动不低于 CUDA 12 的底线（Win 527 / Linux 525；CUDA 12.x 的 minor 版本兼容靠这条底线兜住）。
 *   · **探测失败一律 cpu，绝不抛异常**：没有 nvidia-smi / 超时 / 输出为空 / 字段 N/A，
 *     都只是「量不到」，不是错误 —— 装 CPU 版一定能跑，装 GPU 版则不一定。
 *   · 读数走 gpu-poll.js 的 gpuExecFile（工作线程 + 去重缓存）：nvidia-smi 的 CreateProcess
 *     会占住主进程（= 渲染层）线程，这里不许自己另起一发 execFile。
 *   · 多卡：优先挑「符合条件且空闲最多」的那张，报它的读数。
 */

const { gpuExecFile } = require("../gpu-poll.js");

/** nvidia-smi 采样超时（ms）：这是安装前的一次体检，不在上面久等。 */
const SMI_TIMEOUT_MS = 4000;
/** 总显存门槛（MB）：6GB。 */
const MIN_VRAM_MB = 6 * 1024;
/** CUDA 12 的驱动底线（主版本号）：Windows 527.41 / Linux 525.60.13。 */
const MIN_DRIVER_WIN = 527;
const MIN_DRIVER_LINUX = 525;

/** 集显 / 核显 / 非 N 卡：名字里出现这些就判 cpu（onnxruntime-gpu 用不上）。 */
const INTEGRATED_RE = /intel|amd|radeon|\buhd\b|iris|vega|\bgraphics\b/i;
/** N 卡的识别词。 */
const NVIDIA_RE = /nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i;

const asNum = (v) => {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isFinite(n) ? n : null;
};
const gb1 = (mb) => (mb == null ? null : Math.round((Number(mb) / 1024) * 10) / 10);

/** 解析 `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits`。
 *  单卡 / 多卡都吃；[N/A] / ERR! / 空行 / No devices were found 一律跳过该卡。 */
function parseGpuCsv(stdout) {
  const lines = String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/no devices were found/i.test(l));
  const cards = [];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) continue;
    const totalMb = asNum(parts[1]);
    if (totalMb == null || totalMb <= 0) continue;
    const freeMb = asNum(parts[2]);
    cards.push({
      index: cards.length,
      name: parts[0] || "",
      totalMb,
      freeMb: freeMb == null ? null : Math.max(0, freeMb),
      driver: parts[3] && !/^\[?n\/?a\]?$/i.test(parts[3]) ? parts[3] : null,
    });
  }
  return cards;
}

function cpu(code, reason, card) {
  return { mode: "cpu", code, reason, gpu: gpuOf(card) };
}
function gpuOf(card) {
  if (!card) return { name: "", vramTotalMB: null, vramFreeMB: null, driver: null };
  return {
    name: String(card.name || ""),
    vramTotalMB: card.totalMb == null ? null : Math.round(card.totalMb),
    vramFreeMB: card.freeMb == null ? null : Math.round(card.freeMb),
    driver: card.driver ? String(card.driver) : null,
  };
}

/**
 * 纯判定（便于冒烟 / 临时脚本直调）：
 *   decide(cards, { platform?, minVramMb?, minDriverMajor? })
 *     → { mode:"cuda"|"cpu", code, reason, gpu:{ name, vramTotalMB, vramFreeMB, driver } }
 */
function decide(cards, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const platform = String(o.platform || process.platform);
  const minVram = Number(o.minVramMb) > 0 ? Number(o.minVramMb) : MIN_VRAM_MB;
  const minDriver =
    Number(o.minDriverMajor) > 0 ? Number(o.minDriverMajor) : platform === "win32" ? MIN_DRIVER_WIN : MIN_DRIVER_LINUX;
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && String(c.name || "").trim());
  if (!list.length) return cpu("no_gpu", "未检测到 NVIDIA 显卡（nvidia-smi 没有读数），使用 CPU 推理", null);

  const usable = list.filter((c) => NVIDIA_RE.test(c.name) && !INTEGRATED_RE.test(c.name));
  if (!usable.length) {
    const c = list[0];
    return cpu(
      "not_nvidia",
      "检测到的是 " + String(c.name) + "（集显 / 核显或非 NVIDIA 卡），CUDA 推理用不上，使用 CPU",
      c
    );
  }

  /* 逐张卡过门槛：合格 = null，不合格 = { code, reason } */
  const checked = usable.map((c) => ({ card: c, bad: checkCard(c, minVram, minDriver) }));
  const ok = checked.filter((x) => !x.bad).map((x) => x.card);
  if (ok.length) {
    /* 多卡：挑空闲最多的一张（推理实际会落在它上面） */
    const best = ok.slice().sort((a, b) => (b.freeMb || 0) - (a.freeMb || 0))[0];
    const extra = usable.length > 1 ? " · 共 " + usable.length + " 张卡" : "";
    return {
      mode: "cuda",
      code: "ok",
      reason:
        String(best.name) +
        " · 显存 " +
        gb1(best.freeMb) +
        "G 空闲 / 共 " +
        gb1(best.totalMb) +
        "G · 驱动 " +
        String(best.driver) +
        extra +
        "，使用 CUDA 推理",
      gpu: gpuOf(best),
    };
  }

  /* 都不合格：按「显存最大的那张」报原因，用户看到的才是他关心的卡 */
  const worst = checked.slice().sort((a, b) => b.card.totalMb - a.card.totalMb)[0];
  return cpu(worst.bad.code, worst.bad.reason, worst.card);
}

/** 单卡过门槛：合格返回 null，不合格返回 { code, reason }。 */
function checkCard(c, minVram, minDriver) {
  const driverMajor = c.driver ? asNum(String(c.driver).split(/[.\s]/)[0]) : null;
  if (driverMajor == null) {
    return { code: "driver_unknown", reason: "读不到 " + String(c.name) + " 的驱动版本（nvidia-smi 返回 N/A），使用 CPU" };
  }
  if (driverMajor < minDriver) {
    return {
      code: "driver_old",
      reason: "驱动 " + String(c.driver) + " 低于 CUDA 12 要求的 " + minDriver + "，使用 CPU",
    };
  }
  if (c.totalMb < minVram) {
    return {
      code: "vram_low",
      reason: String(c.name) + " 总显存 " + gb1(c.totalMb) + "G 低于 " + gb1(minVram) + "G 门槛，使用 CPU",
    };
  }
  return null;
}

/** 一次 nvidia-smi 读数（拿不到返回 { ok:false, cards:[], error }，绝不抛）。 */
function readSmi(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const exec = typeof o.execFile === "function" ? o.execFile : gpuExecFile;
  const timeout = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : SMI_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    /* 自己再挂一只兜底定时器：gpuExecFile 正常都会回调，但 worker 卡死时不能让安装链跟着挂住 */
    const timer = setTimeout(() => finish({ ok: false, cards: [], error: "timeout" }), timeout + 2000);
    if (timer.unref) timer.unref();
    try {
      exec(
        "nvidia-smi",
        ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"],
        { windowsHide: true, timeout },
        (err, stdout) => {
          clearTimeout(timer);
          if (err) return finish({ ok: false, cards: [], error: String((err && err.message) || err) });
          const cards = parseGpuCsv(stdout);
          if (!cards.length) return finish({ ok: false, cards: [], error: "no_gpu_reading" });
          finish({ ok: true, cards });
        }
      );
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, cards: [], error: String((e && e.message) || e) });
    }
  });
}

/**
 * 探测一次（对外唯一入口，永不 reject）：
 *   detect({ platform?, execFile?, timeoutMs?, read? }) → { mode, code, reason, gpu }
 *   read 可注入（{cards} 或 Promise），临时脚本 / 冒烟用同一份判定。
 */
function detect(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const read = typeof o.read === "function" ? o.read : () => readSmi(o);
  return Promise.resolve()
    .then(() => read())
    .then((reading) => {
      if (!reading || !reading.ok) {
        const why = String((reading && reading.error) || "probe_failed");
        return cpu("probe_failed", "探测显卡失败（" + why + "），使用 CPU 推理", null);
      }
      return decide(reading.cards, o);
    })
    .catch((e) => cpu("probe_failed", "探测显卡失败（" + String((e && e.message) || e) + "），使用 CPU 推理", null));
}

module.exports = {
  SMI_TIMEOUT_MS,
  MIN_VRAM_MB,
  MIN_DRIVER_WIN,
  MIN_DRIVER_LINUX,
  parseGpuCsv,
  readSmi,
  decide,
  detect,
};
