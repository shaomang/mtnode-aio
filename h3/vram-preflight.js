"use strict";
/**
 * MiniMax H3 执行前的显存预检（纯判定 + 一次 nvidia-smi 读数，零 Electron 依赖）。
 *
 * 为什么需要它（用户现场）：显存不够时 ComfyUI **不会报错**，它只会一直没进度 ——
 * 以前要死等满 1 小时总上限才失败，用户看到的就是「点执行后卡死一小时」。
 * 所以提交任务前先量一次空闲显存：不够就当场拒绝，并把「还剩多少 / 至少要多少」说清楚。
 *
 * 口径（用户共识，改动前先回读）：
 *   · 门槛写死，**不新增任何用户设置项**、不改用户任何任务参数（分辨率 / 时长 / 抽卡）：
 *       生成 / 自建工作流：空闲 ≥ 20G
 *       独立后处理（超分 / 补帧）：空闲 ≥ 12G（这条链峰值在系统内存，显存反而空着）
 *   · **只报总占用，不列占用进程**（用户明确选择；本机 nvidia-smi 的每进程显存全是 [N/A]，
 *     只有总量可靠 —— 列一堆没有数字的进程名只会误导）。
 *   · 读不到读数（无 N 卡 / nvidia-smi 缺失 / 输出为空 / 字段 N/A）→ **不拦**：
 *     探测失败不是「显存不足」，绝不拿它当拒绝理由（与 plugins/vram-gate.js 同一纪律）。
 *   · 多卡：任一张卡的空闲够门槛就放行（报空闲最多的那张）。
 */

const { execFile } = require("child_process");

/** 生成 / 自建工作流的空闲显存门槛（GB）。 */
const GEN_MIN_FREE_GB = 20;
/** 独立后处理（超分 / 补帧）的门槛（GB）。 */
const POST_MIN_FREE_GB = 12;
/** nvidia-smi 采样超时（ms）：预检是「提交前的一次体检」，绝不在这上面久等。 */
const SMI_TIMEOUT_MS = 4000;

const asNum = (v) => {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isFinite(n) ? n : null;
};
const gb1 = (mb) => Math.round((Number(mb) / 1024) * 10) / 10;

/** 解析 `nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits`。
 *  单卡/多卡都吃；[N/A] / ERR! / 空行 / No devices were found 一律跳过该卡。 */
function parseGpuCsv(stdout) {
  const lines = String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/no devices were found/i.test(l));
  const cards = [];
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const usedMb = asNum(parts[1]);
    const totalMb = asNum(parts[2]);
    if (totalMb == null || totalMb <= 0) continue;
    cards.push({
      index: cards.length,
      name: parts[0] || "",
      usedMb,
      totalMb,
      freeMb: usedMb == null ? null : Math.max(0, totalMb - usedMb),
    });
  }
  return cards;
}

/** 一次 nvidia-smi 读数（拿不到返回 { ok:false, error }，绝不抛）。 */
function readVram(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const run = typeof o.execFile === "function" ? o.execFile : execFile;
  const timeout = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : SMI_TIMEOUT_MS;
  return new Promise((resolve) => {
    run(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout },
      (err, stdout) => {
        if (err) return resolve({ ok: false, cards: [], error: String((err && err.message) || err) });
        const cards = parseGpuCsv(stdout);
        if (!cards.length) return resolve({ ok: false, cards: [], error: "no_gpu_reading" });
        resolve({ ok: true, cards });
      },
    );
  });
}

/** 预检结论 → 给用户看的整段中文（节点错误 / 控制台共用同一份，别两处各写一套）。 */
function messageOf(judge) {
  const j = judge || {};
  const head =
    "显存不足，本次没有开始执行：" +
    (j.card || "本机显卡") +
    " 已用 " +
    j.usedGb +
    "G / 共 " +
    j.totalGb +
    "G，只剩 " +
    j.freeGb +
    "G 空闲，本任务至少需要预留 " +
    j.minFreeGb +
    "G 空闲显存。";
  const tail =
    "请先关掉正在占用显存的程序（游戏、正在播视频的浏览器页、其它出图 / 出片 / 本地大模型任务）再重跑。" +
    "显存不够时 ComfyUI 不会报错、只会一直卡着没有进度；本次没有改动你的任何设置参数。";
  return head + "\n" + tail;
}

/**
 * 判定一次（纯函数，便于冒烟）：
 *   judge(cards, minFreeGb) → { ok, skipped?, minFreeGb, card, usedGb, totalGb, freeGb }
 *   ok=false 只在「读到了空闲读数且所有卡都不够」时出现；读不到 → ok=true + skipped 原因。
 */
function judge(cards, minFreeGb) {
  const min = Number(minFreeGb) > 0 ? Number(minFreeGb) : GEN_MIN_FREE_GB;
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && Number(c.freeMb) >= 0);
  if (!list.length) return { ok: true, skipped: "no_gpu_reading", minFreeGb: min };
  /* 多卡：按空闲从多到少挑一张（有空闲够的就放行） */
  const sorted = list.slice().sort((a, b) => Number(b.freeMb) - Number(a.freeMb));
  const best = sorted[0];
  const enough = sorted.some((c) => gb1(c.freeMb) >= min);
  return {
    ok: enough,
    minFreeGb: min,
    card: String(best.name || ""),
    usedGb: gb1(best.usedMb),
    totalGb: gb1(best.totalMb),
    freeGb: gb1(best.freeMb),
  };
}

/**
 * 任务用的一次预检：
 *   gate({ kind:"gen"|"post", force, read }) →
 *     { ok:true, skipped? , judge } | { ok:false, error:"vram_insufficient", message, judge }
 * force=true = 用户已经明确点过「仍然执行」（只对本次这一跑生效），跳过拦截但仍写一行读数。
 */
async function gate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const minFreeGb = String(o.kind || "") === "post" ? POST_MIN_FREE_GB : GEN_MIN_FREE_GB;
  const read = typeof o.read === "function" ? o.read : () => readVram(o);
  const reading = await read();
  const cards = reading && Array.isArray(reading.cards) ? reading.cards : [];
  const j = judge(cards, minFreeGb);
  if (j.ok) return { ok: true, skipped: j.skipped || "", judge: j, forced: !!o.force };
  const message = messageOf(j);
  if (o.force) return { ok: true, forced: true, judge: j, message };
  return { ok: false, error: "vram_insufficient", message, judge: j };
}

module.exports = {
  GEN_MIN_FREE_GB,
  POST_MIN_FREE_GB,
  SMI_TIMEOUT_MS,
  parseGpuCsv,
  readVram,
  judge,
  messageOf,
  gate,
};
