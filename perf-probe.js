"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   系统资源探针（perf-probe.js）—— 顶栏「性能」面板的数据真源（主进程 · 零依赖）。

   本次需求：「显存」按钮改为「性能」，面板里除了原有的本地模型显存释放内容，还要给出
   基本系统资源的检测（磁盘 / 内存 / CPU / GPU / 网络等）。

   为什么单独一只主进程模块（而不是写进 renderer）：
     · 采样要 spawn nvidia-smi / PowerShell / netstat —— 渲染层每开一次面板拉一次，
       多窗口（主窗 + 应用窗）会各拉一份，读数还互相打架；
     · 重查询（CIM 的 CPU 型号 / 网卡累计收发、盘剩余）必须**缓存**：本机实测
       Get-CimInstance / Get-NetAdapterStatistics 各自约 1.2s、Get-PSDrive 约 0.17s、
       nvidia-smi 约 0.04s —— 面板每 1.5s 刷一次轻量项、每 5s 刷一次重项，
       没有缓存就会每秒拉起好几只 PowerShell（历史上「探一次显存就闪一下黑窗」的坑）。
     · 子进程一律 windowsHide（同一条纪律）：不许因为探一次读数给用户闪终端窗。

   采样分档（口径由用户确认）：
     轻量 perf:sample   = CPU / 内存 / GPU（nvidia-smi 37ms）—— 面板每 1.5s 拉一次
     重项 perf:system   = 磁盘剩余 + 网卡收发与实时网速 + TCP 连接数 + 后端端口监听
                          —— 面板每 5s 拉一次，静态事实（CPU 型号 / 网卡名单）只在首次采
   读数拿不到一律如实回 null / available:false（面板写「量不到」），绝不编造数字。
   ═══════════════════════════════════════════════════════════════════════════ */

const os = require("os");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { execFile } = require("child_process");

/* 子进程硬上限：探针卡住不许拖住面板（超时 = 这一项量不到，其余项照常出） */
const CMD_TIMEOUT_MS = 8000;
/* 重项（网卡累计收发 / 盘剩余 / 连接数）的缓存 TTL：与面板 5s 档对齐，略短一点 */
const SLOW_TTL_MS = 4000;
/* 静态事实（CPU 型号 / 存储型号）的缓存 TTL：这些值不会变，缓存失效只为兜底 */
const STATIC_TTL_MS = 600000;
/* 后端端口探测的单端口超时 */
const PORT_PROBE_MS = 400;

/* ── 小工具 ───────────────────────────────────────────────────────────── */

function runCmd(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      execFile(
        file,
        args,
        { windowsHide: true, timeout: Math.max(500, Number(timeoutMs) || CMD_TIMEOUT_MS), maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => finish(err ? null : String(stdout || "")),
      );
    } catch {
      finish(null);
    }
  });
}

/** 跑一段 PowerShell（-NoProfile：用户的 profile 会拖慢甚至改输出）；失败 / 超时回 null */
function runPs(script, timeoutMs) {
  return runCmd(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );
}

function toNum(v) {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** JSON 解析：PowerShell 吐出来的东西可能带 BOM / 半截输出，解析不了就当量不到 */
function parseJson(text) {
  if (text == null) return null;
  const s = String(text).replace(/^\uFEFF/, "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function bytesOf(text) {
  const m = /(\d+)\s*$/.exec(String(text || ""));
  return m ? Number(m[1]) : null;
}

/* ── CPU 采样（Node 的 cpu 时间差；不需要任何子进程） ───────────────────── */

/** 算一份 cpu 用量增量：overall = 全核合计，cores = 每核（与 os.cpus() 同序） */
function cpuDelta(prev, cur) {
  if (!prev || !cur) return null;
  const pct = (p, c) => {
    const dt = c.total - p.total;
    if (!(dt > 0)) return null;
    const busy = dt - (c.idle - p.idle);
    return Math.max(0, Math.min(100, Math.round((busy / dt) * 1000) / 10));
  };
  const cores = [];
  for (let i = 0; i < cur.cores.length; i++) cores.push(pct(prev.cores[i], cur.cores[i]));
  return {
    overall: pct(prev.overall, cur.overall),
    cores,
    /* 逻辑核数：面板画每核占用条要用（拿不到读数时也还能画格子） */
    count: cur.cores.length,
  };
}

function readCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  const cores = cpus.map((c) => {
    const t = (c && c.times) || {};
    const i = Number(t.idle) || 0;
    const s =
      (Number(t.user) || 0) +
      (Number(t.nice) || 0) +
      (Number(t.sys) || 0) +
      (Number(t.irq) || 0);
    idle += i;
    total += i + s;
    return { idle: i, total: i + s };
  });
  return { overall: { idle, total }, cores };
}

/* ── 静态事实：CPU 型号（缓存） ─────────────────────────────────────────── */
let cpuModelCache = { at: 0, value: null };

async function cpuModel() {
  const now = Date.now();
  if (cpuModelCache.value && now - cpuModelCache.at < STATIC_TTL_MS) return cpuModelCache.value;
  const txt = await runPs(
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "(Get-CimInstance Win32_Processor | Select-Object -First 1 -Property Name).Name",
    15000,
  );
  const name = txt == null ? "" : String(txt).trim();
  /* 拿不到 CIM 就退回 os.cpus()[0].model（Node 自己也有型号，只是偶尔带厂商前缀） */
  const fallback = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) || "";
  const value = name || String(fallback).trim() || "";
  cpuModelCache = { at: now, value: value || null };
  return cpuModelCache.value;
}

/* ── GPU：nvidia-smi 一次问全（利用率 / 显存 / 温度 / 功耗 / 风扇） ─────── */

const SMI_FIELDS = [
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "fan.speed",
];

function parseSmiLine(line) {
  const p = String(line || "").split(",").map((s) => s.trim());
  if (p.length < 4) return null;
  const g = {
    name: p[0] || "",
    utilPct: toNum(p[1]),
    usedMb: toNum(p[2]),
    totalMb: toNum(p[3]),
    tempC: toNum(p[4]),
    powerW: toNum(p[5]),
    fanPct: toNum(p[6]),
  };
  if (g.usedMb == null || g.totalMb == null) return null;
  g.memPct = g.totalMb > 0 ? Math.round((g.usedMb / g.totalMb) * 1000) / 10 : null;
  return g;
}

/** 全部 NVIDIA 卡（多卡时面板逐张列）；nvidia-smi 不在 / 无 N 卡 → available:false */
async function readGpu() {
  const out = await runCmd(
    "nvidia-smi",
    ["--query-gpu=" + SMI_FIELDS.join(","), "--format=csv,noheader,nounits"],
    6000,
  );
  if (out == null) {
    return {
      available: false,
      reason: "nvidia-smi 不可用（无 NVIDIA 卡 / 驱动未装）",
      cards: [],
    };
  }
  const cards = String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseSmiLine)
    .filter(Boolean);
  if (!cards.length) {
    return { available: false, reason: "读不到显卡读数（nvidia-smi 输出为空）", cards: [] };
  }
  return { available: true, reason: "", cards };
}

/* ── 磁盘：某个目录所在卷的剩余 / 总量（Get-PSDrive，实测约 0.17s） ─────── */

/** 目录 → 它所在卷的盘符（"E:\" / "C:" / ""）；UNC 与相对路径回 "" */
function volumeRootOf(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const m = /^([A-Za-z]):[\\/]/.exec(s);
  return m ? m[1].toUpperCase() : "";
}

/**
 * 读一个卷的剩余 / 总量。「项目盘」与「数据盘」要分别探（通常同一个盘，但用户可以
 * 把数据目录指到别的盘上）—— 容量是慢项，走 SLOW_TTL_MS 缓存。
 */
async function readVolume(letter) {
  const L = String(letter || "").toUpperCase();
  if (!L) return null;
  const out = await runPs(
    "$d=Get-PSDrive -Name " +
      L +
      " -ErrorAction SilentlyContinue; " +
      "if($d){ [pscustomobject]@{free=[double]$d.Free; used=[double]$d.Used} | ConvertTo-Json -Compress }",
    8000,
  );
  const j = parseJson(out);
  if (!j) return null;
  const free = toNum(j.free);
  const used = toNum(j.used);
  if (free == null || used == null) return null;
  const total = free + used;
  return {
    letter: L + ":",
    freeBytes: free,
    usedBytes: used,
    totalBytes: total,
    freePct: total > 0 ? Math.round((free / total) * 1000) / 10 : null,
  };
}

/* ── 网络：网卡名单（静态）+ 累计收发（慢项，靠两次采样的差算实时网速） ─── */

let netIfaceCache = { at: 0, value: null };

/** 网卡名单：型号 / 状态 / 速率 / 是否无线（静态，缓存 10 分钟） */
async function netIfaces() {
  const now = Date.now();
  if (netIfaceCache.value && now - netIfaceCache.at < STATIC_TTL_MS) return netIfaceCache.value;
  const out = await runPs(
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed,MediaType | ConvertTo-Json -Compress",
    15000,
  );
  const j = parseJson(out);
  const arr = Array.isArray(j) ? j : j ? [j] : [];
  const list = arr.map((a) => ({
    name: String((a && a.Name) || ""),
    desc: String((a && a.InterfaceDescription) || ""),
    status: String((a && a.Status) || ""),
    linkSpeed: String((a && a.LinkSpeed) || ""),
    up: String((a && a.Status) || "").toLowerCase() === "up",
    wireless: /wireless|wi-?fi|802\.11|WLAN/i.test(
      String((a && a.MediaType) || "") + " " + String((a && a.InterfaceDescription) || ""),
    ),
  }));
  netIfaceCache = { at: now, value: list };
  return list;
}

/** 累计收发字节（Get-NetAdapterStatistics；慢项，缓存 TTL 内不重复拉） */
async function netTotalsRaw() {
  const out = await runPs(
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress",
    15000,
  );
  const j = parseJson(out);
  const arr = Array.isArray(j) ? j : j ? [j] : [];
  return arr.map((a) => ({
    name: String((a && a.Name) || ""),
    rx: toNum(a && a.ReceivedBytes),
    tx: toNum(a && a.SentBytes),
  }));
}

/** 实时网速：靠两次累计读数的差 + 时间差算（不额外拉性能计数器）。
 *  每次调用都拉一次累计读数（实测约 0.3s，面板 5s 档足够），差值即「这一段的平均速率」。 */
let netPrev = { at: 0, rows: null };

async function netRates() {
  const now = Date.now();
  const rows = await netTotalsRaw();
  const prev = netPrev;
  const dt = now - prev.at;
  const rates = rows.map((r) => {
    const p = prev.rows ? prev.rows.find((x) => x.name === r.name) : null;
    let rxRate = null;
    let txRate = null;
    /* 第一次采样没有上一次可比 → 如实 null（面板写「采样中」），下一轮就有数了 */
    if (p && dt > 200 && r.rx != null && p.rx != null && r.rx >= p.rx && r.tx >= p.tx) {
      rxRate = Math.max(0, Math.round(((r.rx - p.rx) / dt) * 1000));
      txRate = Math.max(0, Math.round(((r.tx - p.tx) / dt) * 1000));
    }
    return { name: r.name, rx: r.rx, tx: r.tx, rxRate, txRate };
  });
  netPrev = { at: now, rows };
  return rates;
}

/** 本机 TCP 连接数（netstat -ano：Established / Listen / TimeWait 分档） */
async function connCounts() {
  const out = await runCmd("netstat.exe", ["-ano", "-p", "TCP"], 8000);
  if (out == null) return null;
  const lines = String(out).split(/\r?\n/);
  let established = 0;
  let listening = 0;
  let timeWait = 0;
  let other = 0;
  for (const line of lines) {
    if (!/^\s*TCP\s/i.test(line)) continue;
    if (/ESTABLISHED/i.test(line)) established++;
    else if (/LISTENING/i.test(line)) listening++;
    else if (/TIME_WAIT/i.test(line)) timeWait++;
    else other++;
  }
  return { established, listening, timeWait, other, total: established + listening + timeWait + other };
}

/** 单个端口是否有人在监听（连得上 = 在监听；本地回环，开销很小） */
function portListening(port) {
  return new Promise((resolve) => {
    const p = Number(port) || 0;
    if (!p) return resolve(false);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    const sock = net.connect({ host: "127.0.0.1", port: p });
    sock.setTimeout(PORT_PROBE_MS);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/* ── 采样编排 ─────────────────────────────────────────────────────────── */

let cpuPrev = null;
let slowCache = { at: 0, value: null };

/**
 * 轻量采样（面板每 1.5s 拉一次）：CPU 与内存完全没有子进程开销，GPU 一次 nvidia-smi。
 * cpu.overall 在**第一次**调用时是 null（差分需要上一次读数）——面板如实写「采样中」。
 */
async function sample() {
  const cur = readCpuTimes();
  const cpu = cpuDelta(cpuPrev, cur) || { overall: null, cores: [], count: cur.cores.length };
  cpuPrev = cur;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const gpu = await readGpu();
  return {
    ok: true,
    at: Date.now(),
    cpu: Object.assign({}, cpu, { model: cpuModelCache.value || "" }),
    mem: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPct: totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : null,
    },
    gpu,
  };
}

/**
 * 慢项采样（面板每 5s / 手动刷新拉一次）：磁盘剩余 + 网卡与实时网速 + 连接数 + 端口监听。
 * 带 TTL 缓存：5s 档连续两次调用不会重复拉起 PowerShell。
 */
async function system(opts) {
  const o = opts || {};
  const now = Date.now();
  const ports = (Array.isArray(o.ports) ? o.ports : []).map((x) => Number(x) || 0).filter(Boolean);
  const dataDir = String(o.dataDir || "");
  const appDir = String(o.appDir || "");
  const dataLetter = volumeRootOf(dataDir);
  const appLetter = volumeRootOf(appDir);

  if (!o.force && slowCache.value && now - slowCache.at < SLOW_TTL_MS) {
    const cached = slowCache.value;
    /* TTL 内复用重项（网卡 / 连接数 / 卷容量）：避免面板 5s 档与手动刷新叠在一起时
       重复拉起 PowerShell。端口状态便宜且会变，仍然重探。 */
    return Object.assign({}, cached, {
      at: now,
      ports: await probePorts(ports),
    });
  }

  const letters = [];
  for (const L of [dataLetter, appLetter]) if (L && letters.indexOf(L) < 0) letters.push(L);

  const [cpuName, ifaces, rates, conns] = await Promise.all([
    cpuModel(),
    netIfaces(),
    netRates(),
    connCounts(),
  ]);
  const volumes = (await Promise.all(letters.map((L) => readVolume(L))))
    .filter(Boolean)
    .map((v) => {
      const L = v.letter.charAt(0);
      v.role =
        L === dataLetter && L === appLetter
          ? "both"
          : L === dataLetter
            ? "data"
            : "app";
      return v;
    });
  const value = {
    ok: true,
    at: now,
    cpuModel: cpuName || "",
    memTotalBytes: os.totalmem(),
    volumes,
    dataDir,
    appDir,
    net: { ifaces, rates },
    conns,
    ports: await probePorts(ports),
  };
  slowCache = { at: now, value };
  return value;
}

/** 端口探测：把「本地后端端口 → 在不在监听」列表化（拿不到就是 false，不编造） */
async function probePorts(ports) {
  const uniq = [];
  for (const p of ports) if (uniq.indexOf(p) < 0) uniq.push(p);
  const out = [];
  for (const p of uniq) out.push({ port: p, listening: await portListening(p) });
  return out;
}

/** 面板打开时的静态事实（一次就够）：CPU 型号 / 逻辑核数 / 平台 / 数据目录 */
async function statics(opts) {
  const o = opts || {};
  const model = await cpuModel();
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    cpuModel: model || "",
    cores: (os.cpus() || []).length,
    dataDir: String(o.dataDir || ""),
    appDir: String(o.appDir || ""),
    /* 数据目录占用明细不在这里采：那是 storage-clean.js 的全量扫描（秒级到分钟级），
       面板只提供「查看明细」跳去设置里的「存储占用与清理」。 */
  };
}

/* ── IPC 接线（main.js 调一次） ───────────────────────────────────────── */

function registerPerfIpc(opts) {
  const o = opts || {};
  const ipcMain = o.ipcMain || require("electron").ipcMain;
  const dataDir = typeof o.getDataDir === "function" ? o.getDataDir : () => "";
  const projectDir = typeof o.getProjectDir === "function" ? o.getProjectDir : () => "";
  const backendPorts =
    typeof o.getBackendPorts === "function" ? o.getBackendPorts : () => [];
  const guard = (fn) => async (e, arg) => {
    try {
      return await fn(arg);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
  const base = () => ({
    dataDir: String(dataDir() || ""),
    projectDir: String(projectDir() || ""),
  });
  /* 要探的端口 = 本地后端端口（各宿主登记）+ 面板调用方显式补的端口 */
  const portsOf = (arg) => {
    const extra = (arg && Array.isArray(arg.ports) ? arg.ports : []).map((x) => Number(x) || 0);
    let fromHost = [];
    try {
      fromHost = backendPorts() || [];
    } catch {
      fromHost = [];
    }
    return fromHost.concat(extra).filter((p, i, a) => p && a.indexOf(p) === i);
  };

  ipcMain.handle("perf:statics", guard(() => statics(base())));
  ipcMain.handle("perf:sample", guard(() => sample()));
  ipcMain.handle(
    "perf:system",
    guard((arg) =>
      system(
        Object.assign({}, base(), {
          ports: portsOf(arg),
          force: !!(arg && arg.force),
        }),
      ),
    ),
  );
  /* 只要端口状态时用（面板手动刷新） */
  ipcMain.handle(
    "perf:ports",
    guard(async (arg) => ({ ok: true, ports: await probePorts(portsOf(arg)) })),
  );
}

module.exports = {
  registerPerfIpc,
  /* 供冒烟直接调（纯函数 + 采样器） */
  cpuDelta,
  readCpuTimes,
  parseSmiLine,
  volumeRootOf,
  parseJson,
  sample,
  system,
  statics,
  probePorts,
  CMD_TIMEOUT_MS,
  SLOW_TTL_MS,
  PORT_PROBE_MS,
};
