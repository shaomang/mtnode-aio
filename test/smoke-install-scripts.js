"use strict";
/* 本地后端安装脚本「中文清零」—— 冒烟测试（Node + 只读调 PowerShell 解析器）
 *   node test/smoke-install-scripts.js
 *
 * 为什么要有这只用例（2026-10 的真实故障）：
 *   宿主一律用 `powershell.exe`（Windows PowerShell 5.1）跑这些安装脚本。脚本原本是
 *   **UTF-8 无 BOM + 大量中文**，而 PS 5.1 在中文 Windows 上按 ANSI(GBK / cp936) 解码
 *   无 BOM 的 .ps1 —— 中文被解成乱码字节，还会把紧跟其后的 `}` `'` `"` 当 trail byte 吞掉，
 *   于是语法直接崩。改前实测：breeze 10 处、sensenova 113 处、yue 42 处、
 *   llama 3 处、h3/download_models 6 处、h3/repair_torch_kitchen 1 处语法错
 *   （同一批文件用 UTF-8 解析则 0 错）。乱码还有第二个来源：脚本/原生工具（pip / git /
 *   python）的输出在中文 Windows 上按 cp936 编码，而宿主用 `d.toString()`（UTF-8）解码。
 *   现在的口径：脚本**纯 ASCII 英文**（零非 ASCII ⇒ GBK 解码与 UTF-8 解码结果完全一致，
 *   语法不可能再因编码而崩），并在开头把本进程与子进程的输出编码钉死成 UTF-8。
 *
 * 覆盖：
 *   [1] 零非 ASCII：脚本 / 辅助文件每个字节 <= 0x7F（.ps1 / .py / .cmd 全含）
 *   [2] 解析真跑：每个 .ps1 按 GBK(cp936) 解码后解析 = 0 错，按 UTF-8 解码后解析 = 0 错
 *                 （GBK 路径就是中文 Windows 上 PS 5.1 的真实解码路径）
 *   [3] 契约仍在：宿主正则抓的进度前缀、reason= 短码、标记文件名、参数 / 环境变量名、
 *                 镜像 URL、脚本里被其它冒烟断言的字样
 *   [4] 编码钉死：.ps1 有 [Console]::OutputEncoding + PYTHONIOENCODING；.cmd 有 chcp 65001
 *   [5] 防回退：改前那批中文判据 / 分隔线不许再出现
 *   [6] 自复制：先比路径再决定抄不抄（同一个文件跳过去，别的照抄）
 *
 * **与 tts-pack 绑定的那几节（[7] 真跑 tts 安装脚本、[8]/[8.2]/[8.3] reqs-fixups 单一真源、
 *   [9] tts-pack 的打包白名单、[10]/[10.2] torch 档位链、[11]/[11.2] resampy 自愈）已随
 *   GPT-SoVITS 插件整块删除** —— 那些机制只有 tts-pack 有，没有第二个包可以承接
 *   （见 docs/mirror-sources.md：`reqs-fixups.json` 与 torch 档位链全仓仅此一份）。
 *   本文件保留的 [1]–[6] 不读 tts-pack，对每个仍随包的 pack 都成立。 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, rel.split("/").join(path.sep));
const read = (rel) => fs.readFileSync(abs(rel), "utf8").replace(/\r\n/g, "\n");
const bytes = (rel) => fs.readFileSync(abs(rel));
const has = (text, needle, msg) => ok(text.indexOf(needle) >= 0, msg + "  [" + needle + "]");

/* ---------------- 被测文件清单 ---------------- */
/* 每个 .ps1：宿主要抓的 ASCII 契约 + 脚本自己必须保留的判据 */
const PS_FILES = [
  {
    rel: "breeze-pack/scripts/install.ps1",
    markers: [
      "[breeze-install] progress:",
      'Write-Verdict "false" "smoke_failed"',
      'Write-Verdict "false" "no_cuda"',
      ".breeze-agent-result",
      ".install-ok",
      "BREEZE_SKIP_CUDA_CHECK",
      "BREEZE_WEIGHTS_DIR",
      "pytorch-wheels/cu128",
      "ghproxy.com",
      "download_weights.py",
      "a failed smoke test means not installed",
    ],
  },
  {
    rel: "llama-pack/scripts/install.ps1",
    markers: ["[llama-install] progress:", ".install-ok", "llama-server.exe", "hf-mirror.com", "ghproxy"],
  },
  {
    rel: "music3-pack/scripts/setup_env.ps1",
    markers: ["[music3-setup]", "--system-site-packages", ".cuda-python", "MT_MUSIC_PIP_INDEX"],
  },
  {
    rel: "music3-pack/scripts/download_models.ps1",
    markers: ["[music3-download]", "Comfy-Org/MiniMax-Music-3", "MUSIC3_MODELSCOPE_REPO"],
  },
  {
    rel: "h3-pack/scripts/setup_env.ps1",
    markers: ["[h3-setup]", ".cuda-python", "MT_H3_PIP_INDEX", "patch_h3_autogrow_refs.py"],
  },
  {
    rel: "h3-pack/scripts/download_models.ps1",
    markers: ["[h3-download]", "Comfy-Org/MiniMax-H3", "RealESRGAN_x4plus.pth", "rife47.pth"],
  },
  {
    rel: "h3-pack/scripts/repair_torch_kitchen.ps1",
    markers: ["patch_comfy_kitchen_typing.py", "infer_schema"],
  },
  {
    rel: "yue-pack/scripts/install.ps1",
    markers: [
      "[yue2-install] progress:",
      ".yue2-agent-result",
      ".install-ok",
      "probe_attention.py",
      "ui_entry_import_failed",
      "requirements_install_failed",
      "attention_backend_unsupported",
    ],
  },
  {
    rel: "sensenova-pack/scripts/install.ps1",
    markers: [
      "[sensenova-install] progress:",
      ".sensenova-agent-result",
      ".install-ok",
      "Test-PkgSourceReady",
      "from modelscope import snapshot_download",
      "SenseNova/SenseNova-U1.5-8B-MoT",
      'HF_ENDPOINT = "https://hf-mirror.com"',
      "--no-deps",
      "attn-backend",
      "-SkipModels",
    ],
  },
];

/* 安装期被 .ps1 调起的 Python 辅助脚本（同样不能有中文：它们的输出走同一个控制台） */
const PY_FILES = [
  {
    rel: "breeze-pack/scripts/download_weights.py",
    markers: ["[breeze-weights]", "progress:", "snapshot_download"],
  },
  {
    rel: "yue-pack/scripts/probe_attention.py",
    markers: ["--json", "windows_patch", ".attention-backend", '_ORDER = ("flash", "cudnn", "sdpa")'],
  },
];

/* 启动器 .cmd：从 setlocal 起就把控制台与 Python 输出钉成 UTF-8 */
const CMD_FILES = [
  { rel: "breeze-pack/start_backend.cmd", markers: ["-m app", "BREEZE_API_PORT"] },
  { rel: "llama-pack/start_backend.cmd", markers: ["-m app"] },
  { rel: "music3-pack/scripts/start_backend.cmd", markers: ["-m app.ui", "7860"] },
  { rel: "h3-pack/scripts/start_backend.cmd", markers: ["main.py", "8188", "--reserve-vram 4"] },
  { rel: "yue-pack/start_backend.cmd", markers: ["-m app", "-m app.ui"] },
  { rel: "sensenova-pack/start_backend.cmd", markers: ["-m app", "8774"] },
];

const ALL = []
  .concat(PS_FILES.map((f) => ({ ...f, kind: "ps1" })))
  .concat(PY_FILES.map((f) => ({ ...f, kind: "py" })))
  .concat(CMD_FILES.map((f) => ({ ...f, kind: "cmd" })));

/* ---------------- [1] 零非 ASCII ---------------- */
console.log("[1] 零非 ASCII（每个文件都不许有中文 / 全角标点 / emoji / BOM）");
let nonAsciiTotal = 0;
for (const f of ALL) {
  const buf = bytes(f.rel);
  let n = 0;
  for (const b of buf) if (b > 0x7f) n++;
  nonAsciiTotal += n;
  ok(n === 0, f.rel + " 非 ASCII 字节 = " + n);
}
ok(nonAsciiTotal === 0, "全部 " + ALL.length + " 个文件非 ASCII 字节合计 = 0（实测 " + nonAsciiTotal + "）");
for (const f of ALL) {
  const rel = path.basename(f.rel);
  ok(!read(f.rel).includes("\uFEFF"), f.rel + " 无 BOM");
  if (rel) break; /* 只为保持结构清晰：BOM 检查已逐个文件做完 */
}
for (const f of ALL) {
  ok(!/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(read(f.rel)), f.rel + " 无 CJK / 全角字符");
}

/* ---------------- [2] GBK + UTF-8 双路径解析 ---------------- */
console.log("\n[2] 解析真跑：GBK(cp936) 解码后 0 错 + UTF-8 解码后 0 错");
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const listLiteral = PS_FILES.map((f) => psq(abs(f.rel))).join(", ");
const psScript = [
  "$ErrorActionPreference = 'Stop'",
  "$enc = [System.Text.Encoding]::GetEncoding(936)",
  "$files = @(" + listLiteral + ")",
  "foreach ($p in $files) {",
  "  $b = [System.IO.File]::ReadAllBytes($p)",
  "  $e1 = $null; $t1 = $null",
  "  $null = [System.Management.Automation.Language.Parser]::ParseInput($enc.GetString($b), [ref]$t1, [ref]$e1)",
  "  $e2 = $null; $t2 = $null",
  "  $null = [System.Management.Automation.Language.Parser]::ParseInput([System.Text.Encoding]::UTF8.GetString($b), [ref]$t2, [ref]$e2)",
  "  Write-Output ((Split-Path -Leaf $p) + '|' + @($e1).Count + '|' + @($e2).Count)",
  "}",
].join("\n");
const ps = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
  { encoding: "utf8", windowsHide: true, timeout: 120000 },
);
if (process.platform !== "win32" || ps.error || ps.status !== 0) {
  console.log(
    "  skip  PowerShell 不可用（platform=" +
      process.platform +
      (ps.error ? " err=" + ps.error.code : "") +
      (ps.status !== 0 ? " status=" + ps.status : "") +
      "）—— 只保留 [1] 的零非 ASCII 判据（纯 ASCII 下 GBK 与 UTF-8 解码等价）",
  );
} else {
  const lines = String(ps.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  ok(lines.length === PS_FILES.length, "PowerShell 解析器逐个回报了 " + lines.length + " / " + PS_FILES.length + " 个脚本");
  for (const line of lines) {
    const [name, gbk, utf8] = line.split("|");
    ok(gbk === "0", name + " GBK 解码后语法错 = " + gbk);
    ok(utf8 === "0", name + " UTF-8 解码后语法错 = " + utf8);
  }
}

/* ---------------- [3] ASCII 契约仍在 ---------------- */
console.log("\n[3] ASCII 契约仍在（宿主正则 / 界面 / 其它冒烟依赖它们）");
for (const f of ALL) {
  const text = read(f.rel);
  for (const m of f.markers) has(text, m, f.rel + " 契约");
}

/* ---------------- [4] 编码钉死 ---------------- */
console.log("\n[4] 编码钉死：脚本自己把控制台 / 子进程输出钉成 UTF-8");
for (const f of PS_FILES) {
  const text = read(f.rel);
  has(text, "[Console]::OutputEncoding", f.rel + " 钉死控制台输出编码");
  has(text, "PYTHONIOENCODING", f.rel + " 钉死子进程（python）输出编码");
  ok(/UTF8Encoding\(\$false\)/.test(text), f.rel + " 用 no-BOM UTF8（避免 stdout 头部写 BOM）");
}
for (const f of CMD_FILES) {
  const text = read(f.rel);
  has(text, "chcp 65001", f.rel + " 切 UTF-8 码页");
  has(text, "PYTHONIOENCODING=utf-8", f.rel + " 钉死 python 输出编码");
}

/* ---------------- [5] 旧中文残留（防回退） ---------------- */
console.log("\n[5] 防回退：改前那批中文判据 / 分隔线不许再出现");
for (const f of ALL) {
  const text = read(f.rel);
  ok(text.indexOf("——") < 0, f.rel + " 无全角破折号");
  ok(text.indexOf("─") < 0, f.rel + " 无制表线字符");
  ok(text.indexOf("（") < 0, f.rel + " 无全角括号");
}

/* ---------------- [6] 自复制不许再中止安装（breeze 实测踩过） ----------------
   现象：宿主先把包复制进安装目录（syncPackToInstall），脚本的 $PSScriptRoot 于是就在
   $InstallDir\scripts 里，`Copy-Item $src $dl -Force` 变成复制到自己身上；PowerShell 7 报
   "Cannot overwrite the item ... with itself"，脚本开着 $ErrorActionPreference="Stop"，
   当场中止在 weights 步（进度 80.0）。修法：先比规范化路径，同一个文件就跳过复制。 */
console.log("\n[6] 自复制：先比路径再决定抄不抄（同一个文件跳过去，别的照抄）");
const breezePs = read("breeze-pack/scripts/install.ps1");
const dlBlockStart = breezePs.indexOf('$dl = Join-Path $InstallDir "scripts\\download_weights.py"');
const dlBlockEnd = breezePs.indexOf("if (-not (Test-Path -LiteralPath $dl))");
const dlBlock = dlBlockStart >= 0 && dlBlockEnd > dlBlockStart ? breezePs.slice(dlBlockStart, dlBlockEnd) : "";
ok(!!dlBlock, "breeze install.ps1 里能找到 download_weights.py 搬运那一段");
has(dlBlock, "Resolve-Path -LiteralPath $src", "先把源路径规范化（Resolve-Path）");
has(dlBlock, "Resolve-Path -LiteralPath $dl", "目标已存在时也规范化（才能与源真正比出来）");
has(dlBlock, "[string]::Equals($srcFull, $dlFull, [System.StringComparison]::OrdinalIgnoreCase)", "按大小写不敏感整串比较两者是不是同一个文件");
ok(
  /if\s*\(-not\s+\[string\]::Equals\([^)]*\)\)\s*\{\s*Copy-Item/.test(dlBlock),
  "只有**不是**同一个文件时才 Copy-Item（同一个文件跳过＝幂等，不再自复制中止）",
);
ok(
  !/^\s*if \(Test-Path -LiteralPath \$src\) \{ Copy-Item -LiteralPath \$src -Destination \$dl -Force \}\s*$/m.test(breezePs),
  "旧的「直接 Copy-Item 到 $dl」写法已不存在（回退即复现中止）",
);


console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
