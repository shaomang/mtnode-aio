#!/usr/bin/env node
/* test/run-all.mjs — 冒烟回归聚合入口（零依赖 · 逐只跑 · 汇总失败清单）
 * ============================================================================
 * 运行：
 *   npm test                                  # 跑全部 smoke-*.{js,mjs}
 *   node test/run-all.mjs token-budget dialog # 只跑名字含这些子串的
 *   node test/run-all.mjs --list              # 只列清单，不跑
 *
 * 口径：
 *   · 每只子进程都是 `node test/smoke-x.js`（这些脚本自己声称零依赖、不启动
 *     Electron、不碰真实 %APPDATA%；要拦截 require("electron") 的脚本自带假体）。
 *   · 工作目录固定为仓库根（与脚本里的 `../renderer/...` 相对路径一致）。
 *   · 退出码语义由各脚本自己给出（process.exit / process.exitCode）；本入口只
 *     负责按序跑、计时、落日志、汇总，绝不改写或吞掉任何一只的判定。
 *   · 默认「失败继续」（fail fast 会让后面 100 只没结果），最后统一汇总。
 *   · 全绿 → 退出码 0；有任何一只红 / 超时 → 退出码 1（可挂到发版链上当闸门）。
 *
 * 开关：
 *   --only=a,b        等价于位置参数过滤（子串匹配，不区分大小写）
 *   --timeout=SECONDS 单只上限（默认 300）；超时判 timeout 并杀进程
 *   --tail=N          汇总里每只失败贴多少行关键输出（默认 24）
 *   --log-dir=PATH    完整输出落盘目录（默认 <tmp>/mtnode-smoke-logs/<时间戳>）
 *   --include-manual  连 MANUAL 表里那些需要外部服务/人工前置的一起跑
 *   --list            只打印将要运行的清单后退出
 * ============================================================================
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT, "test");

/* 需要真实外部服务或人工前置的脚本：默认排除，否则聚合入口在别的机器上必红。
 * 想跑它们：node test/run-all.mjs --include-manual <子串> */
const MANUAL = new Map([
  [
    "smoke-db-dsh.mjs",
    "真连 DeepSeek 官方 API（要密钥 + 出网），且凭据路径硬编码到本机某用户目录",
  ],
]);

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flags = { manual: false, list: false };
const filters = [];
let timeoutSec = 300;
let tailN = 24;
let logDirArg = "";
for (const a of argv) {
  if (a === "--include-manual") flags.manual = true;
  else if (a === "--list") flags.list = true;
  else if (a.startsWith("--only="))
    filters.push(...a.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
  else if (a.startsWith("--timeout=")) timeoutSec = Number(a.slice(10)) || 300;
  else if (a.startsWith("--tail=")) tailN = Number(a.slice(7)) || 24;
  else if (a.startsWith("--log-dir=")) logDirArg = a.slice(10);
  else if (a.startsWith("--")) {
    console.error("未知开关：" + a);
    process.exit(2);
  } else filters.push(a);
}
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) timeoutSec = 300;

/* ---------------- 清单 ---------------- */
const all = fs
  .readdirSync(TEST_DIR)
  .filter((n) => /^smoke-.+\.(js|mjs)$/.test(n))
  .sort();

const lower = filters.map((s) => s.toLowerCase());
const picked = all.filter(
  (n) => !lower.length || lower.some((f) => n.toLowerCase().includes(f)),
);
const skippedManual = picked.filter((n) => MANUAL.has(n) && !flags.manual);
const queue = picked.filter((n) => !MANUAL.has(n) || flags.manual);

if (flags.list) {
  console.log("test/ 下 smoke-* 共 " + all.length + " 只，本次将跑 " + queue.length + " 只：");
  for (const n of queue) console.log("  · " + n + (MANUAL.has(n) ? "  [manual]" : ""));
  if (skippedManual.length) {
    console.log("默认跳过（--include-manual 才跑）：");
    for (const n of skippedManual) console.log("  - " + n + "  ← " + MANUAL.get(n));
  }
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const LOG_DIR = logDirArg
  ? path.resolve(ROOT, logDirArg)
  : path.join(os.tmpdir(), "mtnode-smoke-logs", stamp);
fs.mkdirSync(LOG_DIR, { recursive: true });

/* ---------------- 工具 ---------------- */
const C = {
  dim: (s) => "\x1b[2m" + s + "\x1b[0m",
  green: (s) => "\x1b[32m" + s + "\x1b[0m",
  red: (s) => "\x1b[31m" + s + "\x1b[0m",
  yellow: (s) => "\x1b[33m" + s + "\x1b[0m",
  bold: (s) => "\x1b[1m" + s + "\x1b[0m",
};

/* 各脚本的「战果行」措辞不统一，这里只做展示用的提取，不参与判定。 */
function tallyOf(text) {
  let best = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(PASS|OK|FAILED|FAIL|✗|✓)\b|项(全部)?通过|项检查|\/ ?\d+ ?项/.test(line)) {
      const t = line.trim();
      if (t.length <= 120) best = t;
    }
  }
  return best;
}

function keyLines(text, n) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/FAIL|fail|✗|MISS|Error|error:|异常|超时|not defined|ENOENT|Cannot |TypeError|ReferenceError|Assertion/i.test(line))
      out.push(line.trim());
  }
  const uniq = out.filter((v, i) => out.indexOf(v) === i);
  return uniq.slice(-n);
}

function runOne(file) {
  const abs = path.join(TEST_DIR, file);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let truncated = false;
    const CAP = 8 * 1024 * 1024; // 单只输出上限 8 MB，防止某只刷屏吃光内存
    const push = (chunk) => {
      if (out.length < CAP) out += chunk;
      else truncated = true;
    };
    child.stdout.on("data", (c) => push(String(c)));
    child.stderr.on("data", (c) => push(String(c)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      const extra = (e && (e.stack || e.message)) || String(e);
      resolve({ file, status: "spawn-error", code: -1, ms: Date.now() - t0, out: out + "\n" + extra, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let status;
      if (timedOut) status = "timeout";
      else if (code === 0) status = "pass";
      else status = "fail";
      resolve({ file, status, code, ms: Date.now() - t0, out, truncated });
    });
  });
}

/* ---------------- 主循环（逐只，不并发） ---------------- */
console.log(
  C.bold(
    `MTNode 冒烟聚合 · ${queue.length} 只（跳过 manual ${skippedManual.length}）· 单只超时 ${timeoutSec}s · 日志 ${LOG_DIR}`,
  ),
);
const results = [];
let pass = 0;
for (let i = 0; i < queue.length; i++) {
  const file = queue[i];
  const tag = `${String(i + 1).padStart(3)}/${queue.length}`;
  process.stdout.write(C.dim(`[${tag}] ${file.padEnd(38)}`));
  const r = await runOne(file);
  results.push(r);
  fs.writeFileSync(path.join(LOG_DIR, file + ".log"), r.out, "utf8");
  const tally = tallyOf(r.out);
  const dur = (r.ms / 1000).toFixed(1) + "s";
  if (r.status === "pass") {
    pass++;
    console.log(C.green(" pass ") + C.dim(` ${dur}  ${tally}`));
  } else {
    console.log(
      C.red(" " + r.status + " ") +
        C.dim(` exit=${r.code} ${dur}  ${tally}${r.truncated ? "  (输出截断)" : ""}`),
    );
  }
}

/* ---------------- 汇总 ---------------- */
const bad = results.filter((r) => r.status !== "pass");
const totalMs = results.reduce((a, r) => a + r.ms, 0);
const lines = [];
lines.push(`MTNode 冒烟聚合 ${stamp}`);
lines.push(`跑了 ${results.length} 只：pass ${pass} · fail ${results.filter((r) => r.status === "fail").length} · timeout ${results.filter((r) => r.status === "timeout").length} · spawn-error ${results.filter((r) => r.status === "spawn-error").length}`);
lines.push(`墙钟（各只耗时之和） ${(totalMs / 1000).toFixed(1)}s · 单只超时上限 ${timeoutSec}s`);
if (skippedManual.length) {
  lines.push("");
  lines.push(`默认跳过 ${skippedManual.length} 只（--include-manual 才跑）：`);
  for (const n of skippedManual) lines.push(`  - ${n}  ← ${MANUAL.get(n)}`);
}
lines.push("");
lines.push("最慢 5 只：" );
for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 5))
  lines.push(`  ${(r.ms / 1000).toFixed(1)}s  ${r.file}  [${r.status}]`);
if (!bad.length) {
  lines.push("");
  lines.push("✅ 全绿");
} else {
  lines.push("");
  lines.push(C.red(`❌ 失败 ${bad.length} 只`));
  for (const r of bad) {
    lines.push("");
    lines.push(`── ${r.file}  [${r.status}] exit=${r.code} ${(r.ms / 1000).toFixed(1)}s`);
    lines.push(`   完整输出：${path.join(LOG_DIR, r.file + ".log")}`);
    for (const l of keyLines(r.out, tailN)) lines.push("   | " + l);
  }
}
const summary = lines.join("\n");
fs.writeFileSync(path.join(LOG_DIR, "summary.txt"), summary + "\n", "utf8");
console.log("\n" + summary + "\n");
console.log(C.dim("汇总已写入 " + path.join(LOG_DIR, "summary.txt")));
process.exitCode = bad.length ? 1 : 0;
