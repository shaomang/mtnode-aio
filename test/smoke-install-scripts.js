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
 * 覆盖（**自动发现**，见下面「被测文件清单」——不再维护手写清单）：
 *   [1] 零非 ASCII：脚本 / 辅助文件每个字节 <= 0x7F（.ps1 / .py / .cmd 全含）
 *   [2] 解析真跑：每个 .ps1 按 GBK(cp936) 解码后解析 = 0 错，按 UTF-8 解码后解析 = 0 错
 *                 （GBK 路径就是中文 Windows 上 PS 5.1 的真实解码路径）
 *   [3] 契约仍在：宿主正则抓的进度前缀、reason= 短码、标记文件名、参数 / 环境变量名、
 *                 镜像 URL、脚本里被其它冒烟断言的字样
 *   [4] 编码钉死：.ps1 有 [Console]::OutputEncoding + PYTHONIOENCODING；.cmd 有 chcp 65001
 *   [5] 防回退：改前那批中文判据 / 分隔线不许再出现
 *   [6] 自复制：先比路径再决定抄不抄（同一个文件跳过去，别的照抄）
 *   [13] 读文件必须显式声明编码：脚本里凡 `Get-Content` 等按文本读一个文件的地方，都要写
 *        `-Encoding UTF8` —— 不写就是交给 PS 5.1 按机器 ANSI 代码页解码；别的包的中文文案
 *        不在这份脚本里也不代表安全（同包 `steps.json` 是 UTF-8 中文的错误码文案表）
 *   [14] 随包 JSON 清单必须纯 ASCII：**会被 PowerShell / 子进程读的那些**
 *        —— 每包 `manifest.json`（llama 的 install.ps1 要读 `llamaRelease`，历史故障正是它里面的
 *        中文把 ConvertFrom-Json 解崩）与本轮新增的 `*-pack/**`（除 node_modules）`package.json`
 *        （npm 子进程按机器代码页读它）。文案位改英文，给人看的中文只在
 *        plugins/catalog.default.json 与各包 steps.json，并钉住
 *        「零非 ASCII + 无 BOM + 仍是合法 JSON」。`steps.json` / `package-lock.json` /
 *        ComfyUI 工作流 / Live2D 模型配置有意保留中文，不在本节。
 *
 * **与 tts-pack 绑定的那几节（[7] 真跑 tts 安装脚本、[8]/[8.2]/[8.3] reqs-fixups 单一真源、
 *   [9] tts-pack 的打包白名单、[10]/[10.2] torch 档位链、[11]/[11.2] resampy 自愈）已随
 *   GPT-SoVITS 插件整块删除** —— 那些机制只有 tts-pack 有，没有第二个包可以承接
 *   （见 docs/mirror-sources.md：`reqs-fixups.json` 与 torch 档位链全仓仅此一份）。
 *   本文件保留的 [1]–[6] 不读 tts-pack，对每个仍随包的 pack 都成立。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
/* 绝对路径找 powershell.exe：[12] 会把子进程 PATH 缩到最小（模拟干净机器），
   那时靠 PATH 找 "powershell.exe" 会 ENOENT。 */
const PS_EXE = (() => {
  const cands = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  for (const c of cands) {
    const r = spawnSync(c, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true, timeout: 30000 });
    if (r && r.status === 0) return c;
  }
  return "powershell.exe";
})();

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

/* ---------------- 被测文件清单（自动发现 + 显式豁免） ----------------
   口径（2026-11 共识）：零非 ASCII 这条纪律**不再靠手写清单维护** —— 守卫自己递归扫，
   新加的包 / 脚本 / 共享库自动进网。为什么改成自动发现：手写清单已经漏过 4 个随包脚本
   （`music3-pack/scripts/run_app.ps1`、`music3-pack/start_backend.cmd`、`h3-pack/start_backend.cmd`、
   `remotion-pack/install.cmd`），也漏过共享安装库 `scripts/mtnode-torch-wheel.ps1`
   （1328 个非 ASCII 字节的注释，头注释写明要被各包 install.ps1 dot-source）。

   覆盖：
     · 所有 `*-pack/**` 的 `.ps1` / `.cmd` / `.bat`；
     · 所有 `*-pack/scripts/` 下的 `.py`（安装期被 .ps1 调起的辅助脚本，按**位置**口径判定）；
     · 共享真源 `pack-steps/`、`pack-python/`；
     · 项目 `scripts/**` 的 `.ps1` / `.cmd` / `.bat`（它们可能被 install.ps1 dot-source）。

   显式豁免（有意为之，不是待办）：
     · `*-pack/app/**`、`*-pack/shims/**` 的后端运行时 Python —— UTF-8 源码，Python 按 UTF-8 读，
       没有 PS 5.1 按 ANSI 解码无 BOM .ps1 的隐患（口径见 docs/mirror-sources.md §九）；
     · `steps.json` / `README.md` 等非脚本文件（给人看的中文文案就该在那儿）；
       `manifest.json` **不再豁免** —— 它会被 PS 读，见本节 [14]；
     · 构建产物与依赖目录（node_modules / dist / dist_check / .dsh-probe / venv / __pycache__）。

   [1]/[2] 跑的是自动发现的全体；下面 PS_FILES 只在 [3]–[11] 里当「契约与判据表」用
   （每个文件的 marker、是否 spawn python、是否要钉控制台编码）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".dsh-probe",
  "dist",
  "dist_check",
  "venv",
  ".venv",
  "__pycache__",
]);
const TEXT_EXT_RE = /\.(ps1|cmd|bat)$/i;
/* `*-pack/scripts/` 下的全部 `.py` = 安装期辅助脚本（按位置口径）。 */
const AUX_PY_RE = /^[^/]+-pack\/scripts\/.*\.py$/i;
/** 后端运行时 Python：显式豁免（改这条要同步 docs/mirror-sources.md §九）。 */
const RUNTIME_PY_DIR_RE = /^[^/]+\/(app|shims)\//;

function walkFiles(dir, out) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of ents) {
    if (it.name.startsWith(".")) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walkFiles(full, out);
    } else {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
}

/** 自动发现的覆盖集（排序稳定）：COVERED_ALL = 零非 ASCII 全体；COVERED_PS1 = 还要双解码解析的。 */
const COVERED_ALL = [];
const COVERED_PS1 = [];
(function discoverCoverage() {
  const packs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /-pack$/.test(e.name))
    .map((e) => e.name)
    .sort();
  ok(packs.length >= 8, "扫到 " + packs.length + " 个随包目录（*-pack）");
  for (const pack of packs) {
    const found = [];
    walkFiles(path.join(ROOT, pack), found);
    for (const rel of found) {
      if (RUNTIME_PY_DIR_RE.test(rel)) continue; /* 后端运行时 Python 豁免 */
      if (TEXT_EXT_RE.test(rel) || AUX_PY_RE.test(rel)) COVERED_ALL.push(rel);
    }
  }
  /* 共享真源 + 项目 scripts/ 下的 PS 系脚本（可能被 install.ps1 dot-source） */
  for (const shared of ["pack-steps", "pack-python", "scripts"]) {
    const found = [];
    walkFiles(path.join(ROOT, shared), found);
    for (const rel of found) if (TEXT_EXT_RE.test(rel)) COVERED_ALL.push(rel);
  }
  COVERED_ALL.sort();
  for (const rel of COVERED_ALL) if (/\.ps1$/i.test(rel)) COVERED_PS1.push(rel);
})();

/* 覆盖面自检：守卫不许自己空转（新增包 / 脚本被漏掉时，这几条会先报红） */
console.log("[0] 覆盖集自检：自动发现的安装脚本一览");
const MUST_COVER = [
  "pack-steps/step.ps1",
  "pack-python/base_python.ps1",
  "scripts/mtnode-torch-wheel.ps1",
  "breeze-pack/scripts/install.ps1",
  "h3-pack/scripts/install.ps1",
  "llama-pack/scripts/install.ps1",
  "music3-pack/scripts/install.ps1",
  "remotion-pack/scripts/install.ps1",
  "sensenova-pack/scripts/install.ps1",
  "yue-pack/scripts/install.ps1",
  "music3-pack/scripts/run_app.ps1",
  "h3-pack/start_backend.cmd",
  "remotion-pack/install.cmd",
  "breeze-pack/scripts/download_weights.py",
  "h3-pack/scripts/patch_comfy_kitchen_typing.py",
  "yue-pack/scripts/probe_attention.py",
];
for (const rel of MUST_COVER) ok(COVERED_ALL.indexOf(rel) >= 0, "覆盖到 " + rel);
ok(
  COVERED_ALL.length >= 24,
  "自动发现扫到 " + COVERED_ALL.length + " 个安装脚本 / 辅助脚本（低于下限说明发现逻辑空转了）",
);
ok(
  COVERED_PS1.length >= 20,
  "其中 .ps1 = " + COVERED_PS1.length + " 个（要逐个做 GBK / UTF-8 双解码解析）",
);
/* 豁免不许被无声扩大：运行时 Python 一个都不许溜进覆盖集 */
for (const rel of COVERED_ALL) {
  ok(
    !RUNTIME_PY_DIR_RE.test(rel),
    rel + " 不是后端运行时 Python（`*-pack/app|shims/*.py` 明确豁免，不许混进覆盖集）",
  );
}

/* 每个 .ps1：宿主要抓的 ASCII 契约 + 脚本自己必须保留的判据。
 *   · console=true   脚本自己把控制台输出编码钉成 UTF-8（会往 stdout 打步骤行 / 进度行的都算）；
 *   · pythonOut=true 脚本会 spawn python / native 工具，必须同时钉 PYTHONIOENCODING；
 *   · 步骤协议库 step.ps1 只打步骤行、不 spawn 任何东西，所以两条都不要求（它自己的纯 ASCII
 *     与双解码可解析性由本文件的 [1]/[2] 统一把关）。 */
const PS_FILES = [
  {
    rel: "pack-steps/step.ps1",
    proto: true,
    markers: [
      "mtnodeStep",
      '"run|ok|fail|skip"',
      "function Step-ProgressMap",
      "function Step-Progress",
      "function Step-Begin",
      "function Step-Fail",
      "PURE ASCII",
    ],
  },
  {
    rel: "yue-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "breeze-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "llama-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "h3-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "music3-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "sensenova-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "remotion-pack/scripts/step.ps1",
    proto: true,
    markers: ["mtnodeStep", "function Step-ProgressMap", "function Step-Progress"],
  },
  {
    rel: "h3-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
    markers: [
      "[h3-install]",
      "Step-Begin",
      "Skip-AfterStep",
      "New-FailCode",
      "-SourceOnly",
      "comfy_kitchen",
    ],
  },
  {
    rel: "music3-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
    markers: ["[music3-install]", "Step-Begin", "New-FailCode"],
  },
  {
    rel: "remotion-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
    markers: ["node", "registry.npmmirror.com"],
  },
  {
    rel: "breeze-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
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
    console: true,
    pythonOut: true,
    markers: ["[llama-install] progress:", ".install-ok", "llama-server.exe", "hf-mirror.com", "ghproxy"],
  },
  {
    rel: "music3-pack/scripts/setup_env.ps1",
    console: true,
    pythonOut: true,
    markers: ["[music3-setup]", "base_python.ps1", ".cuda-python", "MT_MUSIC_PIP_INDEX", "MT_MUSIC_TORCH_INDEX"],
  },
  {
    rel: "music3-pack/scripts/download_models.ps1",
    console: true,
    pythonOut: true,
    markers: ["[music3-download]", "Comfy-Org/MiniMax-Music-3", "MUSIC3_MODELSCOPE_REPO"],
  },
  {
    rel: "h3-pack/scripts/setup_env.ps1",
    console: true,
    pythonOut: true,
    markers: ["[h3-setup]", "base_python.ps1", ".cuda-python", "MT_H3_PIP_INDEX", "patch_h3_autogrow_refs.py"],
  },
  /* 三套 Python 后端的共同基座获取器：真源 pack-python/base_python.ps1 + 各包一份逐字节副本 */
  {
    rel: "h3-pack/scripts/base_python.ps1",
    console: true,
    pythonOut: true,
    markers: ["python-build-standalone", "uv python install", "WantedCsv", "gpu.none", "python.missing"],
  },
  {
    rel: "music3-pack/scripts/base_python.ps1",
    console: true,
    pythonOut: true,
    markers: ["python-build-standalone", "uv python install", "WantedCsv"],
  },
  {
    rel: "yue-pack/scripts/base_python.ps1",
    console: true,
    pythonOut: true,
    markers: ["python-build-standalone", "uv python install", "WantedCsv"],
  },
  {
    rel: "h3-pack/scripts/download_models.ps1",
    console: true,
    pythonOut: true,
    markers: ["[h3-download]", "Comfy-Org/MiniMax-H3", "RealESRGAN_x4plus.pth", "rife47.pth"],
  },
  {
    rel: "h3-pack/scripts/repair_torch_kitchen.ps1",
    console: true,
    pythonOut: true,
    markers: ["patch_comfy_kitchen_typing.py", "infer_schema"],
  },
  {
    rel: "yue-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
    markers: [
      "[yue2-install] progress:",
      ".yue2-agent-result",
      ".install-ok",
      ".attention-backend",
      "install:default:cudnn",
      "ui_entry_import_failed",
      "requirements_install_failed",
      "base_python.ps1",
      "yue2.python.missing",
    ],
  },
  {
    rel: "sensenova-pack/scripts/install.ps1",
    console: true,
    pythonOut: true,
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
    markers: ["--json", "--only", "windows_patch", ".attention-backend", "resolve_backend"],
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

/* [3]–[11] 用的**契约表**（marker / 是否 spawn python / 是否要钉编码 / 文案表 / 标题真源）：
   它是断言用的名单，不是覆盖面的真源 —— 覆盖面由上面的自动发现决定，两者必须对得上
   （下面紧接着钉一条：契约表里每个文件都必须在覆盖集内）。 */
const ALL = []
  .concat(PS_FILES.map((f) => ({ ...f, kind: "ps1" })))
  .concat(PY_FILES.map((f) => ({ ...f, kind: "py" })))
  .concat(CMD_FILES.map((f) => ({ ...f, kind: "cmd" })));
for (const f of ALL) {
  ok(COVERED_ALL.indexOf(f.rel) >= 0, "契约表里的 " + f.rel + " 在自动发现的覆盖集内");
}

/* ---------------- [1] 零非 ASCII ---------------- */
console.log("[1] 零非 ASCII（覆盖集全体：不许有中文 / 全角标点 / emoji / BOM）");
let nonAsciiTotal = 0;
for (const rel of COVERED_ALL) {
  const buf = bytes(rel);
  let n = 0;
  for (const b of buf) if (b > 0x7f) n++;
  nonAsciiTotal += n;
  ok(n === 0, rel + " 非 ASCII 字节 = " + n);
}
ok(
  nonAsciiTotal === 0,
  "覆盖集 " + COVERED_ALL.length + " 个文件非 ASCII 字节合计 = 0（实测 " + nonAsciiTotal + "）",
);
/* BOM 逐个文件都查：它本身是 ASCII 范围内的字节（EF BB BF 里的 BF > 0x7F 会被上面抓到，
   但 BOM 的存在还会让 PS 5.1 走 UTF-8 解码这条路，两种解码行为不一致，所以单独钉住）。 */
for (const rel of COVERED_ALL) {
  ok(!read(rel).includes("\uFEFF"), rel + " 无 BOM");
}
for (const rel of COVERED_ALL) {
  ok(!/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(read(rel)), rel + " 无 CJK / 全角字符");
}

/* ---------------- [2] GBK + UTF-8 双路径解析 ---------------- */
console.log("\n[2] 解析真跑：GBK(cp936) 解码后 0 错 + UTF-8 解码后 0 错");
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const listLiteral = COVERED_PS1.map((rel) => psq(abs(rel))).join(", ");
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
  ok(
    lines.length === COVERED_PS1.length,
    "PowerShell 解析器逐个回报了 " + lines.length + " / " + COVERED_PS1.length + " 个脚本",
  );
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
console.log("\n[4] 编码钉死：会 spawn 的脚本自己把控制台 / 子进程输出钉成 UTF-8");
for (const f of PS_FILES) {
  if (!f.console && !f.pythonOut) continue;
  const text = read(f.rel);
  has(text, "[Console]::OutputEncoding", f.rel + " 钉死控制台输出编码");
  ok(/UTF8Encoding\(\$false\)/.test(text), f.rel + " 用 no-BOM UTF8（避免 stdout 头部写 BOM）");
  if (f.pythonOut) has(text, "PYTHONIOENCODING", f.rel + " 钉死子进程（python）输出编码");
}
for (const f of CMD_FILES) {
  const text = read(f.rel);
  has(text, "chcp 65001", f.rel + " 切 UTF-8 码页");
  has(text, "PYTHONIOENCODING=utf-8", f.rel + " 钉死 python 输出编码");
}

/* ---------------- [5] 旧中文残留（防回退） ---------------- */
console.log("\n[5] 防回退：改前那批中文判据 / 分隔线不许再出现（覆盖集全体）");
for (const rel of COVERED_ALL) {
  const text = read(rel);
  ok(text.indexOf("——") < 0, rel + " 无全角破折号");
  ok(text.indexOf("─") < 0, rel + " 无制表线字符");
  ok(text.indexOf("（") < 0, rel + " 无全角括号");
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


/* ---------------- [7] 失败文案表：脚本只打错误码，中文文案在 steps.json ----------------
   为什么要有这一节：脚本必须纯 ASCII（PS 5.1 在中文 Windows 上按 ANSI 解码无 BOM 的 .ps1），
   所以「失败原因 + 处置建议」这类给人看的文本不能写在脚本里。口径 = 脚本打稳定错误码 +
   动态参数，各包 steps.json 的 `messages` 表出本地化文案，宿主 install-steps.js 解析。
   这一节钉三件事：① 脚本里每个 code 都能在 steps.json 查到；② 表里中英都有；
   ③ 模板占位与脚本给的参数对得上（打错键就查不出原因）。 */
console.log("\n[7] 失败文案表：脚本里的错误码都能在 steps.json 查到中英文案，占位符对得上");
const stepLib = require(path.join(ROOT, "plugins/install-steps.js"));
const CODE_PACKS = [
  { pack: "h3-pack", script: "h3-pack/scripts/install.ps1" },
  { pack: "music3-pack", script: "music3-pack/scripts/install.ps1" },
];
for (const p of CODE_PACKS) {
  const src = read(p.script);
  const codes = [];
  const codeRe = /New-FailCode\s+"([A-Za-z0-9_.-]+)"/g;
  for (let m = codeRe.exec(src); m; m = codeRe.exec(src)) codes.push(m[1]);
  ok(codes.length > 0, p.script + " 至少打一个结构化错误码（New-FailCode）");
  ok(
    new Set(codes).size === codes.length,
    p.script + " 错误码不重复（实得 " + codes.length + " 个 / 去重 " + new Set(codes).size + " 个）",
  );
  const man = JSON.parse(read(p.pack + "/steps.json"));
  const table = Object.create(null);
  for (const s of man.steps || []) {
    for (const [code, v] of Object.entries((s && s.messages) || {})) table[code] = { step: s.id, text: v };
  }
  ok(Object.keys(table).length > 0, p.pack + "/steps.json 有 messages 失败文案表");
  const norm = stepLib.normManifest(man);
  for (const code of codes) {
    const hit = table[code];
    ok(!!hit, p.script + " 的 " + code + " 在 " + p.pack + "/steps.json 有文案");
    if (!hit) continue;
    const zh = String((hit.text && hit.text.zh) || "").trim();
    const en = String((hit.text && hit.text.en) || "").trim();
    ok(!!zh && !!en, code + " 中英文案都有（zh " + zh.length + " 字 / en " + en.length + " 字符）");
  }
  /* 占位符：模板里的 {key} 必须真被脚本传进来（tail 允许空，其余必须有值来源）。
     只对「脚本里字面写出的 code」较真：安装脚本也可以**动态**取码（如把候选子脚本报的
     FAILCODE 原样上抛，h3.gpu.none / music3.python.missing 就是这么进安装窗的）——
     那种 code 在脚本里只以变量形式出现，正则自然找不到参数来源，不该误判为缺项。 */
  for (const [code, hit] of Object.entries(table)) {
    if (!codes.includes(code) || src.indexOf("New-FailCode \"" + code + "\"") < 0) continue;
    const used = new Set();
    for (const lang of ["zh", "en"]) {
      const text = String((hit.text && hit.text[lang]) || "");
      for (const m of text.matchAll(/\{([A-Za-z0-9_]{1,32})\}/g)) used.add(m[1]);
    }
    for (const key of used) {
      const call = new RegExp('New-FailCode\\s+"' + code + '"[^\\n]*?' + key + '\\s*=');
      ok(call.test(src), code + " 的占位 {" + key + "} 有对应的参数来源（New-FailCode " + key + "=…）");
    }
  }
  /* 解析真跑：中文优先，英文可选；表里没有的 code 回空串（宿主退回脚本英文 message） */
  const withTable = norm.steps.find((s) => s.messages && Object.keys(s.messages).length);
  ok(!!withTable, p.pack + " 的 messages 表进了 normManifest（安装窗按它解析）");
  if (withTable) {
    const code = Object.keys(withTable.messages)[0];
    const zh = stepLib.stepErrorText({ code, messages: withTable.messages, params: {} }, "zh");
    const en = stepLib.stepErrorText({ code, messages: withTable.messages, params: {} }, "en");
    ok(/[\u4e00-\u9fff]/.test(zh), p.pack + " 默认（中文界面）解析出中文文案：" + zh.slice(0, 24) + "…");
    ok(!!en && !/[\u4e00-\u9fff]/.test(en), p.pack + " 英文界面解析出英文文案");
    ok(
      stepLib.stepErrorText({ code: "nope.unknown.code", messages: withTable.messages }, "zh") === "",
      p.pack + " 表里没有的 code 回空串（宿主退回脚本英文 message）",
    );
    /* 占位替换真的发生：随便塞一个参数，模板里的 {x} 不许原样留在输出里 */
    const anyKey = /\{([A-Za-z0-9_]{1,32})\}/.exec(String(withTable.messages[code].zh || withTable.messages[code].en));
    if (anyKey && anyKey[1] !== "tail") {
      const filled = stepLib.stepErrorText({ code, messages: withTable.messages, params: { [anyKey[1]]: "ZZ9" } }, "zh");
      ok(filled.indexOf("ZZ9") >= 0, code + " 的 {" + anyKey[1] + "} 用参数替换（不再原样留着）");
    }
  }
}

/* ---------------- [8] 步骤标题不在脚本里：steps.json 是唯一真源 ----------------
   脚本一律 Step-Begin "<id>" "" <pct>（第二参为空标题），安装窗按 steps.json 渲染标题 ——
   这样脚本不必为了界面文案而写非 ASCII。 */
console.log("\n[8] 标题真源：会本地化标题的包，脚本 Step-Begin 的第二参必须是空标题");
for (const p of PS_FILES) {
  if (!/\/scripts\/install\.ps1$/.test(p.rel)) continue;
  const pack = p.rel.split("/")[0];
  const manPath = pack + "/steps.json";
  const man = fs.existsSync(abs(manPath)) ? JSON.parse(read(manPath)) : { steps: [] };
  /* 只对「清单里给了标题的步」较真：那些步的标题由安装窗按 steps.json 渲染，脚本再写一份
     就是第二真源（也会逼着脚本写非 ASCII）。清单里没有的包（窗口插件 / 桌宠走兜底表）
     脚本自带英文标题是允许的（英文 = ASCII，不违反编码纪律）。 */
  const declared = new Set((man.steps || []).map((s) => String(s.id || "")));
  const src = read(p.rel);
  const bad = [];
  const beginRe = /Step-Begin\s+"([^"]*)"\s+("([^"]*)"|'([^']*)')/g;
  for (let m = beginRe.exec(src); m; m = beginRe.exec(src)) {
    const id = m[1];
    const title = m[3] != null ? m[3] : m[4];
    if (title && declared.has(id)) bad.push(id + "=" + title);
  }
  ok(
    bad.length === 0,
    p.rel + " 里清单声明过的步骤不带标题（实得 " + bad.length + (bad.length ? "：" + bad.slice(0, 3).join(" / ") : "") + "）",
  );
  /* 进度门槛表（Step-ProgressMap）同理：适配层只把进度翻成步骤 id，标题的真源仍是 steps.json。 */
  const mapBad = [];
  const mapRe = /@\{\s*at\s*=\s*\d+;\s*id\s*=\s*"([^"]+)";\s*title\s*=\s*"([^"]*)"/g;
  for (let m = mapRe.exec(src); m; m = mapRe.exec(src)) {
    if (m[2]) mapBad.push(m[1] + "=" + m[2]);
  }
  ok(
    mapBad.length === 0,
    p.rel + " 的 Step-ProgressMap 也不带标题（实得 " + mapBad.length + (mapBad.length ? "：" + mapBad.slice(0, 3).join(" / ") : "") + "）",
  );
}

/* ---------------- [9] 结构化失败真跑：Step-Fail 必须收 [object] ----------------
   现场（本轮实现期实测）：脚本里 `Step-Fail "venv" (New-FailCode …)` 传给的是 [ordered] 哈希，
   而函数签名若写成 param([string]$Id, [string]$Message)，PowerShell 会把它转成字符串
   "System.Collections.Specialized.OrderedDictionary" —— 错误码与参数当场丢光，安装窗只剩
   这一串类型名。所以 [8] 之后必须再钉一条：打错误码的脚本，Step-Fail 的 Message 参数是 [object]。 */
console.log("\n[9] 结构化失败真跑：Step-Fail 收 [object]，错误码 / 参数原样出现在步骤行里");
for (const p of CODE_PACKS) {
  const src = read(p.script);
  if (src.indexOf("New-FailCode") < 0) continue;
  const sig = (src.match(/function Step-Fail \{ param\(([^)]*)\)/) || [])[1] || "";
  ok(/\[object\]\s*\$Message/.test(sig), p.script + " 的 Step-Fail 声明 [object]$Message（否则结构化失败被转成类型名）");
}
if (process.platform === "win32" && PS_FILES.length) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-step9-"));
  try {
    fs.copyFileSync(path.join(ROOT, "pack-steps/step.ps1"), path.join(tmp, "step.ps1"));
    fs.writeFileSync(
      path.join(tmp, "emit.ps1"),
      [
        '. (Join-Path $PSScriptRoot "step.ps1")',
        'function New-FailCode { param([string]$Code,[hashtable]$Params,[string]$Message)',
        '  $o = [ordered]@{ code = $Code }; if ($Params -and $Params.Count) { $o.params = $Params }; $o.message = $Message; return $o }',
        'Step-Fail "venv" (New-FailCode "h3.venv.pip_failed" @{ venv = "C:/x/python.exe"; tail = "ERROR: no matching distribution" } "environment prep did not finish")',
      ].join("\r\n"),
      "utf8",
    );
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(tmp, "emit.ps1")],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    const line = String(r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.indexOf("mtnodeStep") >= 0);
    const parsed = line ? require(path.join(ROOT, "plugins/install-steps.js")).parseStepLine(line) : null;
    ok(!!parsed, "[9] PowerShell 真跑的失败行能被宿主解析：" + String(line || "(无输出)").slice(0, 80));
    ok(!!parsed && parsed.step.code === "h3.venv.pip_failed", "[9] 错误码原样穿过 Step-Fail（不被 [string] 吃掉）");
    ok(!!parsed && parsed.step.params && parsed.step.params.venv === "C:/x/python.exe", "[9] 参数一并穿过（venv / tail）");
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
} else {
  console.log("  skip  [9] 真跑需要 Windows + PowerShell");
}

/* ---------------- [10] 基座 Python 获取链（本轮修的现场） ----------------
   现场：h3-pack/scripts/setup_env.ps1 要求「一个已经装好 CUDA torch 的 Python」才肯建隔离
   venv，而往那个 venv 里装 CUDA torch 正是它自己的活。新机器（没 conda、PATH 上只有
   python.org / Microsoft Store 的 Python）候选全空，脚本在装 torch 之前就抛
   "Need a Python with CUDA torch. Pass -CudaPython <path> or set MT_H3_CUDA_PYTHON."
   这一节钉住新口径：判据是**解释器版本**，没有就自己取（uv → npmmirror 的
   python-build-standalone），三套包共用同一份逐字节一致的 base_python.ps1。 */
console.log("\n[10] 基座 Python 获取链：不再要求带 CUDA torch，三包共用一份逐字节一致的实现");
const BASE_SRC_REL = "pack-python/base_python.ps1";
const BASE_SRC = abs(BASE_SRC_REL);
ok(fs.existsSync(BASE_SRC), "真源 " + BASE_SRC_REL + " 在（同 pack-steps / pack-shims 的「真源 + 各包副本」约定）");
const BASE_PACKS = ["h3-pack", "music3-pack", "yue-pack"];
if (fs.existsSync(BASE_SRC)) {
  const buf = fs.readFileSync(BASE_SRC);
  const src = buf.toString("utf8");
  for (const rel of [BASE_SRC_REL].concat(BASE_PACKS.map((p) => p + "/scripts/base_python.ps1"))) {
    const copy = abs(rel);
    ok(fs.existsSync(copy), rel + " 存在");
    if (!fs.existsSync(copy)) continue;
    ok(fs.readFileSync(copy).equals(buf), rel + " 与真源逐字节一致（改真源必须同步副本）");
  }
  has(src, "python-build-standalone", "自己取解释器：走 npmmirror 的 python-build-standalone");
  has(src, "registry.npmmirror.com/-/binary/python-build-standalone", "下载源是 npmmirror 二进制镜像");
  has(src, "uv python install", "有 uv 时先让 uv 取（与 sensenova 同一口径）");
  has(src, "Test-WantedVersion", "判据是解释器版本，不是 torch.cuda.is_available()");
  has(src, "WantedCsv", "版本用逗号串传入（powershell -File 会按位置吞掉数组参数）");
  /* 判据只认「非注释行」：文件头注释里引用历史报错（原话）是有意保留的现场说明 */
  const codeOnly = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  ok(
    codeOnly.indexOf("torch.cuda.is_available") < 0,
    "基座解释器的判据里不再拿 torch.cuda.is_available() 当门槛（那正是原 bug；它只出现在说明注释里）",
  );
  has(src, "IsPathRooted", "缓存目录必须是绝对路径（相对路径会落到应用目录里）");
  has(src, "gpu.none", "显卡体检：无 N 卡给稳定码");
  has(src, "gpu.driver_old", "显卡体检：驱动过旧给稳定码");
  ok(
    !/[^\x00-\x7f]/.test(src),
    "真源纯 ASCII（PS 5.1 在中文 Windows 上按 ANSI 解码无 BOM 的 .ps1）",
  );
  /* 真跑一次「只体检显卡」模式：不下载任何东西，退出码必须 0，且打出结构化键值 */
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BASE_SRC, "-SkipGpuProbe", "-Module", "h3"],
      { encoding: "utf8", windowsHide: true, timeout: 60000 },
    );
    ok(r.status === 0, "[10] -SkipGpuProbe 真跑退出码 0（实得 " + r.status + "）");
    const out = String(r.stdout || "");
    has(out, "STATUS=", "[10] 真跑打出结构化键值行");
    /* 体检本身必须真跑：有卡就报 GPU=/DRIVER=，没卡就报 GPU-NONE=+失败码 ——
       只看退出码会漏掉「探针根本没执行」（本轮实测踩过：探针被写反的条件跳过，
       探针只吐 STATUS=ok，测试却全绿）。 */
    ok(
      /(^|\n)(GPU=|GPU-NONE=)/m.test(out),
      "[10] 体检真的执行了（打出 GPU= 或 GPU-NONE=，实得：" + JSON.stringify(out.slice(0, 80)) + "）",
    );
    /* 无卡路径（离线替身）：require 模式必须给出带包前缀的稳定失败码 */
    const fake = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BASE_SRC, "-SkipGpuProbe", "-Module", "h3", "-GpuRequired", "require"],
      { encoding: "utf8", windowsHide: true, timeout: 60000, env: { ...process.env, MTNODE_FAKE_NO_GPU: "1" } },
    );
    ok(fake.status === 1, "[10] 替身「无 N 卡」+ require 真跑退出码 1（实得 " + fake.status + "）");
    has(String(fake.stdout || ""), "FAILCODE=h3.gpu.none", "[10] 无卡给出稳定失败码 h3.gpu.none");
    /* 显式覆盖（-CudaPython / MT_*_CUDA_PYTHON 的落点）必须**真的生效**。本轮实测踩过：
       参数名写成 -Explicit 时，`powershell -File` 把它绑成空串（同一份脚本里别的参数都正常），
       用户传进来的解释器被静默忽略 —— 所以这里真跑「合格 → 采用 / 太旧 → 稳定码 /
       太新 → 稳定码」三条。参数名是 -ExplicitPython，别改回短名。 */
    const runHelper = (args) =>
      spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BASE_SRC, ...args], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
      });
    const cacheRoot = path.join(process.env.APPDATA || "", "pipeline-console", "python", "standalone");
    const pyOk = ["3.11", "3.12"].map((v) => path.join(cacheRoot, v, "python", "python.exe")).find((p) => fs.existsSync(p)) || "";
    if (pyOk) {
      const good = runHelper(["-Module", "h3", "-GpuRequired", "skip", "-ExplicitPython", pyOk]);
      const goodOut = String(good.stdout || "") + String(good.stderr || "");
      ok(good.status === 0 && goodOut.indexOf("SOURCE=explicit") >= 0, "[10] 显式指定的合格解释器真的被采用（SOURCE=explicit）");
      ok(goodOut.indexOf("override from -ExplicitPython") >= 0, "[10] 覆盖被记账（不是静默忽略）");
    } else {
      console.log("  skip  [10] 显式覆盖真跑：缓存里没有 3.11 / 3.12 解释器");
    }
    const storePy = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "python.exe");
    if (fs.existsSync(storePy)) {
      const oldRes = runHelper(["-Module", "h3", "-GpuRequired", "skip", "-ExplicitPython", storePy]);
      ok(oldRes.status === 1, "[10] 显式指定的旧解释器被拒（退出码 1，实得 " + oldRes.status + "）");
      has(String(oldRes.stdout || ""), "FAILCODE=h3.python.too_old", "[10] 版本过旧报 h3.python.too_old");
    }
    const py313 = path.join(cacheRoot, "3.13", "python", "python.exe");
    if (fs.existsSync(py313)) {
      const nu = runHelper(["-Module", "h3", "-GpuRequired", "skip", "-ExplicitPython", py313]);
      ok(nu.status === 1, "[10] 显式指定的过新解释器被拒（退出码 1，实得 " + nu.status + "）");
      has(String(nu.stdout || ""), "FAILCODE=h3.python.too_new", "[10] 版本过新报 h3.python.too_new");
    } else {
      console.log("  skip  [10] 过新拒绝路径：缓存里没有 3.13 解释器");
    }
  }
}
for (const p of BASE_PACKS) {
  const inst = read(p + "/scripts/install.ps1");
  has(inst, "base_python.ps1", p + " 的 install.ps1 调共享体检器（失败码才会带上 gpu.* / python.*）");
}
for (const rel of ["h3-pack/scripts/setup_env.ps1", "music3-pack/scripts/setup_env.ps1", "yue-pack/scripts/install.ps1"]) {
  const text = read(rel);
  /* 原 bug 的那句前置条件不许再被 throw 出来（注释里引用历史报错是允许的） */
  ok(
    !/throw[^\n]*Need a Python with CUDA torch/.test(text),
    rel + " 不再把「Need a Python with CUDA torch」当初置条件抛出来",
  );
  has(text, "base_python.ps1", rel + " 改为调用共享基座获取器");
}
{
  /* 真口径：建 venv 的调用不许再带 --system-site-packages（注释里解释历史是允许的） */
  const venvCalls = [];
  for (const rel of ["h3-pack/scripts/setup_env.ps1", "music3-pack/scripts/setup_env.ps1"]) {
    for (const line of read(rel).split(/\r?\n/)) {
      if (/-m\s+venv/.test(line)) venvCalls.push(rel + " :: " + line.trim());
    }
  }
  ok(venvCalls.length >= 2, "h3 / music3 都能找到建 venv 的调用（实得 " + venvCalls.length + "）");
  ok(
    venvCalls.every((l) => l.indexOf("--system-site-packages") < 0),
    "建 venv 时一律不带 --system-site-packages（隔离环境；music3 改为在 venv 里自己装 cu130）",
  );
}
has(read("music3-pack/scripts/setup_env.ps1"), "torch==2.9.1+cu130", "music3 在 venv 里装 CUDA torch");
has(read("yue-pack/scripts/install.ps1"), "yue2.python.missing", "yue2 的取 Python 失败走稳定码（不再是 python_not_found 死路）");
ok(
  read("yue-pack/scripts/install.ps1").indexOf("python_not_found") < 0,
  "yue2 的旧码 python_not_found 已退役（它只教用户自己去装 Python 3.12）",
);

/* ---------------- [11] 无 N 卡的编排真跑：稳定码直达安装窗 ----------------
   现场（本轮实测）：体检子脚本非 0 退出会先被 Invoke-SubScript 抛成 "…exit code 1"，
   于是安装窗只看到通用的 h3.venv.prep_failed，稳定码 h3.gpu.none 被丢掉 ——
   用户拿到的是「环境准备失败」，而不是「这台机器没有 N 卡」。这一节用离线替身
   （MTNODE_FAKE_NO_GPU=1，等价于 nvidia-smi 缺失）真跑一遍 h3 的 install.ps1。 */
console.log("\n[11] 无 N 卡编排真跑：venv 步报 h3.gpu.none（不是通用 prep_failed），后续步标 skip");
if (process.platform === "win32" && fs.existsSync(abs("h3-pack/scripts/base_python.ps1"))) {
  const orch = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-install-nogpu-"));
  try {
    fs.mkdirSync(path.join(orch, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(orch, "ComfyUI"), { recursive: true });
    fs.writeFileSync(path.join(orch, "ComfyUI", "main.py"), "# stub\r\n", "utf8");
    for (const n of ["install.ps1", "step.ps1", "setup_env.ps1", "base_python.ps1", "download_models.ps1"]) {
      fs.copyFileSync(abs("h3-pack/scripts/" + n), path.join(orch, "scripts", n));
    }
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(orch, "scripts", "install.ps1"), "-InstallDir", orch, "-DiskHintGb", "0"],
      { encoding: "utf8", windowsHide: true, timeout: 180000, env: { ...process.env, MTNODE_FAKE_NO_GPU: "1" } },
    );
    ok(r.status !== 0, "[11] 无卡时 install.ps1 以非 0 退出（实得 " + r.status + "）");
    const lines = String(r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.indexOf("mtnodeStep") >= 0)
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const venv = lines.filter((l) => l.id === "venv" && l.status === "fail").pop();
    ok(!!venv, "[11] venv 步判失败");
    ok(!!venv && venv.code === "h3.gpu.none", "[11] 报的是稳定码 h3.gpu.none（实得 " + String(venv && venv.code) + "）");
    ok(
      !!venv && !!venv.params && /GPU-NONE|nvidia-smi/.test(String(venv.params.tail || "")),
      "[11] tail 带体检原始行（用户能自己复核）",
    );
    for (const id of ["nodes", "weights", "smoke"]) {
      const st = lines.filter((l) => l.id === id).pop();
      ok(!!st && st.status === "skip", "[11] " + id + " 步标「已跳过」（不在「待执行」上吊着）");
    }
  } finally {
    try {
      fs.rmSync(orch, { recursive: true, force: true });
    } catch {}
  }
} else {
  console.log("  skip  [11] 真跑需要 Windows + PowerShell");
}

/* ---------------- [12] 干净机器真跑：取基座 Python → 建 venv（到 torch 下载前停） ----------------
   这一节跑的是**真代码真网络**（不是读文本）：把 h3-pack 的 setup_env.ps1 + base_python.ps1
   放进临时安装目录、清空 conda/PATH 变量（模拟一台没有 Python 的干净机器）、缓存指到临时目录，
   看它自己把 3.11 取下来、把隔离 venv 建起来。脚本在 venv 建好后打 `[h3-test] stage2-venv-ready`
   （MT_H3_MARK_STAGE2=1 才打），见到它就杀掉进程 —— 后面的 ~3GB torch 下载不在这条测试里。 */
console.log("\n[12] 干净机器真跑：自动取 Python 3.11 + 建隔离 venv（跑到 torch 前停）");
const REAL_RUN = process.env.MTNODE_SMOKE_REAL_RUN !== "0";
async function cleanMachineRun() {
  if (!(process.platform === "win32" && fs.existsSync(BASE_SRC) && REAL_RUN)) {
    console.log("  skip  [12] 真跑需要 Windows + PowerShell" + (REAL_RUN ? "" : "（MTNODE_SMOKE_REAL_RUN=0 已关闭）"));
    return;
  }
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-basepy-run-"));
  const cache = path.join(run, "cache");
  const root = path.join(run, "install");
  const log = path.join(run, "run.log");
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "ComfyUI"), { recursive: true });
    fs.writeFileSync(path.join(root, "ComfyUI", "main.py"), "# stub\r\n", "utf8");
    for (const n of ["setup_env.ps1", "base_python.ps1"]) fs.copyFileSync(abs("h3-pack/scripts/" + n), path.join(root, "scripts", n));
    /* 干净机器：没有 conda / py launcher / PATH 上的 python，也没有 MT_* 覆盖 */
    const env = { ...process.env, MT_H3_MARK_STAGE2: "1", MT_H3_PYTHON_CACHE: cache };
    for (const k of ["MT_CUDA_PYTHON", "MT_H3_CUDA_PYTHON", "MT_H3_PYTHON", "MT_MUSIC_CUDA_PYTHON", "MT_YUE2_CUDA_PYTHON", "MT_YUE2_PYTHON"]) delete env[k];
    env.PATH = "C:\\Windows\\System32;C:\\Windows";
    env.USERPROFILE = run;
    env.LOCALAPPDATA = path.join(run, "local");
    env.APPDATA = path.join(run, "roaming");
    const fd = fs.openSync(log, "w");
    const child = spawn(
      PS_EXE,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "setup_env.ps1")],
      { cwd: root, windowsHide: true, env, stdio: ["ignore", fd, fd] },
    );
    const state = { venvReady: false, exitAt: 0 };
    child.on("exit", () => {
      state.exitAt = Date.now();
    });
    const t0 = Date.now();
    await new Promise((res) => {
      const tick = setInterval(() => {
        let txt = "";
        try {
          txt = fs.readFileSync(log, "utf8");
        } catch {}
        if (txt.indexOf("stage2-venv-ready") >= 0) {
          state.venvReady = true;
          clearInterval(tick);
          try {
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          } catch {}
          res();
          return;
        }
        if (state.exitAt || Date.now() - t0 > 600000) {
          clearInterval(tick);
          res();
        }
      }, 500);
    });
    try {
      fs.closeSync(fd);
    } catch {}
    const txt = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    ok(state.venvReady, "[12] 干净机器上真跑到了「隔离 venv 已建好」（日志尾部：" + JSON.stringify(txt.slice(-200)) + "）");
    const vpy = path.join(root, "ComfyUI", "venv", "Scripts", "python.exe");
    ok(fs.existsSync(vpy), "[12] 隔离 venv 真的建出来了：" + vpy);
    if (fs.existsSync(vpy)) {
      const probe = spawnSync(vpy, ["-c", "import sys,json;print(json.dumps({'v':'.'.join(map(str,sys.version_info[:3])),'exe':sys.executable}))"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
      });
      ok(probe.status === 0, "[12] venv 解释器能跑（exit " + probe.status + "）");
      const info = (() => {
        try {
          return JSON.parse(String(probe.stdout || "").trim().split(/\r?\n/).pop());
        } catch {
          return null;
        }
      })();
      ok(!!info && /^3\.(11|12)\./.test(info.v), "[12] venv 里是 3.11 / 3.12（实得 " + (info && info.v) + "）");
      ok(!!info && info.exe.toLowerCase().indexOf("comfyui") >= 0, "[12] venv 的 sys.executable 落在 ComfyUI\\venv 里（不是基座解释器）");
    }
    has(txt, "Selected base python:", "[12] 日志里能看出基座解释器是怎么选出来的");
    ok(
      /SOURCE=(standalone|uv|path|conda|explicit)/.test(txt),
      "[12] 取解释器的来源被记账（SOURCE=…）",
    );
  } finally {
    try {
      fs.rmSync(run, { recursive: true, force: true });
    } catch {}
  }
}

/* ---------------- [13] 读文件必须显式声明 UTF-8 ----------------
   现场（2026-10 的真实故障，llama-pack/scripts/install.ps1:136-142 的 WHY 注释记着原话）：
   脚本读同包 `manifest.json`（UTF-8 无 BOM，里面是中文文案）时没写 `-Encoding UTF8`，PS 5.1
   按机器 ANSI(cp936) 解码，`。` 的尾字节与结尾引号拼成一个 GBK 双字节字，字符串永不闭合，
   `ConvertFrom-Json` 当场抛 "Invalid object passed in, ':' or '}' expected."（251 行位置）。

   [1] 的「脚本零非 ASCII」只管**脚本自己的字节**，管不到它读的文件 —— 这两条纪律必须都有：
   中文文案可以放在 steps.json / manifest.json（给人看的），但读了就得显式按 UTF-8 读。
   所以本节扫的是**调用点**，不是文件内容：
     · `Get-Content` / `Select-String` / `Import-Csv`（PS 5.1 默认按 ANSI 解码文本文件）
       必须带显式 UTF-8 编码，或该行注明了「输入是纯 ASCII，跳过有理」；
     · `ReadAllBytes` / `ReadAllText` 属 .NET 静态读取，编码行为与 ANSI 无关，豁免；
     · 正则里的裸 URL 不是读文件，忽略。
   为什么放在冒烟里而不是只留注释：注释不会拦住任何人。 */
console.log("\n[13] 读文件必须显式声明 UTF-8：pack 脚本的 Get-Content 等调用点逐个查");
const READ_CMD_RE = /\b(Get-Content|Select-String|Import-Csv)\b/;
const URLISH_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const PS_UTF8_RE = /-Encoding\s+(?:"UTF8"|'UTF8'|UTF8)\b|\[(?:System\.)?Text\.Encoding\]::UTF8|UTF8Encoding/;
const ASCII_NOTE_RE = /ASCII-only input|pure ASCII/i;
const PY_READ_CTX_RE = /\b(?:json\.load|read_text|Path\([^)]*\)\.open|\.open)\(/;
const PY_UTF8_RE = /encoding\s*=\s*["']utf-?8["']/;
const packPdFiles = [];
function walkPd(dir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of ents) {
    if (it.name.startsWith(".")) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walkPd(full);
    } else if (/\.(ps1|py|cmd|bat)$/i.test(it.name)) packPdFiles.push(full);
  }
}
walkPd(ROOT);
const PD_REL = (p) => path.relative(ROOT, p).split(path.sep).join("/");
/** pack/scripts 下的脚本（含共享真源）：安装期由 PS 5.1 或 Node 直接跑的那批。 */
function isPackScriptFile(rel) {
  const parts = rel.split("/");
  if (parts[0] === "pack-steps" || parts[0] === "pack-python") return true;
  return /-pack$/.test(parts[0]) && parts[1] === "scripts";
}
const pdFiles = packPdFiles
  .filter((p) => isPackScriptFile(PD_REL(p)))
  .map(PD_REL)
  .sort();
ok(
  pdFiles.length >= 20,
  "[13] 扫到 " + pdFiles.length + " 个 pack 脚本文件（*.ps1 / *.py / *.cmd，低于下限说明发现逻辑空转了）",
);
/* 备选写法也认：`-Encoding "UTF8"` / `[Text.Encoding]::UTF8` / `New-Object UTF8Encoding` 都能
   真正按 UTF-8 读（本节查的是「有没有显式声明」，不是某一种写法）。 */
/* 「输入是纯 ASCII」的跳过标记：写在被读调用紧上方的一行注释里（`# ASCII-only input ...`），
   也接受行内尾注释。这样 skip 必须在代码里留下可见理由，而不是靠豁免表漂在别处。 */
const ASCII_SKIP_MARK = "# ASCII-only input";
/** 扫描一份脚本文本里的「按文本读文件」调用点：返回 {rel, line, text} 违规清单 + 命中总数。
 *  真源只有这一份 —— 下面的守卫自检直接复用它，保证「夹具里会报红」与「仓库里全绿」同源。 */
function scanReadCalls(label, text, hits) {
  const out = [];
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const unfolded = [lines[i]];
    while (/`\s*$/.test(unfolded[unfolded.length - 1]) && i + 1 < lines.length) unfolded.push(lines[++i]);
    const logical = unfolded.join(" ").trim();
    const skipNote = (lines[i - 1] || "").trim();
    if (!READ_CMD_RE.test(logical)) continue;
    if (/^\s*#/.test(logical)) continue; /* 纯注释行 */
    if (URLISH_RE.test(logical)) continue; /* 正则里的裸 URL 不是读文件 */
    hits.push(label + ":" + (i + 1));
    if (PS_UTF8_RE.test(logical)) continue; /* 已显式声明 UTF-8 */
    if (skipNote.indexOf(ASCII_SKIP_MARK) >= 0) continue; /* 上一行注明输入是纯 ASCII */
    if (ASCII_NOTE_RE.test(logical)) continue;
    out.push({ rel: label, line: i + 1, text: logical.slice(0, 120) });
  }
  return out;
}
const readHits = [];
const readViolations = [];
for (const rel of pdFiles) readViolations.push(...scanReadCalls(rel, read(rel), readHits));
for (const v of readViolations) ok(false, "[13] 读文件没声明 UTF-8：" + v.rel + ":" + v.line + "  " + v.text);
ok(
  readViolations.length === 0,
  "[13] 全部 " + readHits.length + " 处按文本读文件的地方都显式声明了编码（违规 " + readViolations.length + " 处）",
);
ok(
  readHits.length >= 6,
  "[13] 真的扫到了读取调用（" + readHits.length + " 处；0 处说明扫描条件写错了、本节会静默空转）",
);
/* llama 那处是这条纪律的起点：manifest.json 是唯一被 PowerShell 解析的随包 JSON，绝不许退回 ANSI 读法 */
const llamaInst = read("llama-pack/scripts/install.ps1");
has(llamaInst, "Get-Content manifest.json -Raw -Encoding UTF8", "[13] llama install.ps1 读随包 manifest.json 显式 UTF-8（历史故障点）");
has(llamaInst, "WHY -Encoding UTF8", "[13] llama install.ps1 保留 WHY 注释（说明为什么必须显式）");
has(llamaInst, "manifest.json is now pure ASCII", "[13] llama install.ps1 的 WHY 注释写明第二道保险：清单本身已纯 ASCII（[14]）");
/* 共享真源 base_python.ps1 的候选标记是**第三处**同类风险：它读 `.cuda-python`（用户可编辑的文件） */
for (const rel of ["pack-python/base_python.ps1", "h3-pack/scripts/base_python.ps1", "music3-pack/scripts/base_python.ps1", "yue-pack/scripts/base_python.ps1"]) {
  has(read(rel), "Get-Content -LiteralPath $mrk -Encoding UTF8", "[13] " + rel + " 读候选标记显式 UTF-8");
}
/* Python 侧同一纪律（pack 的辅助脚本）：按文本读文件一律 encoding=utf-8，json.load 不接受文件对象 */
for (const rel of pdFiles.filter((p) => /\.py$/i.test(p))) {
  const text = read(rel);
  const lines = text.split("\n");
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#/.test(l)) continue;
    if (!PY_READ_CTX_RE.test(l)) continue;
    if (PY_UTF8_RE.test(l)) continue;
    bad.push((i + 1) + " " + l.trim().slice(0, 100));
  }
  ok(bad.length === 0, "[13] " + rel + " 的文本读取都带 encoding=utf-8（违规 " + bad.length + (bad.length ? "：" + bad.slice(0, 2).join(" / ") : "") + "）");
}
ok(
  !/json\.load\(\s*[A-Za-z_$]/.test(pdFiles.filter((p) => /\.py$/i.test(p)).map(read).join("\n")),
  "[13] pack 辅助 Python 里没有裸 json.load(文件对象)（那种写法按 locale 编码读，中文包会崩）",
);
/* ---------------- [14] 随包 JSON 清单也必须纯 ASCII ----------------
   同一个故障的第二个源头（2026-10 现场，用户报错原文）：
     `…\vLLM\scripts\install.ps1:135  ConvertFrom-Json : 传入的对象无效，应为":"或"}". (251)`
   脚本读的是同包 `manifest.json`，而 PS 5.1 按机器 ANSI(cp936) 解码 UTF-8 无 BOM 的 JSON ——
   里面的中文（`title.zh` / `subtitle.zh` / `notes.zh`）被解成乱码，结尾引号被汉字的 trail byte 吞掉，
   JSON 当场碎掉。当时 llama-pack/scripts/install.ps1 是靠补 `-Encoding UTF8` 修的（[13] 钉着那处），
   本轮把根因也去掉：**宿主 / 安装脚本会解析的随包 JSON 本身零非 ASCII**，
   这样无论哪种读法（显式 UTF-8 / 漏写编码 / 别的机器别的代码页）结果都一致，不可能再因编码崩。

   口径（与 [1] 的「脚本零非 ASCII」同一条纪律，只是对象换成脚本会读的清单）：
     · `*-pack/manifest.json` 逐字节 ≤ 0x7F，且必须仍是合法 JSON（能 JSON.parse）；
     · 这些清单**不是给人看的文案位** —— 插件卡标题 / 简介的真源是 `plugins/catalog.default.json`
       （Node 按 UTF-8 读，不受此限）与各包 `steps.json`；清单里只留机器读的字段，
       文案位（title / subtitle / notes / name / description / license.note）一律英文。
       实测：全仓 JS 只读这些清单的 id / version / apiPort / backendPort / diskHintGb / llamaRelease /
       models / vramModes / chainOfThought / entry / model / modelModelScope / inferPackage / zipUrl / sha256
       / license.weights / license.code，没有一处读 title / subtitle / notes。
     · 为什么不在 [1] 里顺手管 `manifest.json`：`steps.json` 是**有意保留中文**的（错误码文案表，
       Node 按 UTF-8 读），按扩展名一刀切会把那份也扫成违例；所以这里按**文件名**精准收口。 */
console.log("\n[14] 随包 JSON 清单必须纯 ASCII：安装脚本 / npm 子进程会用它，不靠代码页运气");
const packDirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /-pack$/.test(e.name))
  .map((e) => e.name)
  .sort();
/* 本轮扩面：从「唯一被 PS 解析的 manifest.json」扩到**会被 PowerShell / 子进程读的随包 JSON** ——
   `*-pack/**` 下除 node_modules 之外的每一份 `package.json`（npm 装依赖 / 起 render 时按机器代码页
   读它，description 里的中文就是那类现场：一屏 npm WARN 乱码，用户只看到「文字报错」）。
   仍有意不覆盖（中文该留就留）：steps.json（错误码文案表，Node 按 UTF-8 读）、package-lock.json
   （npm 自己写自己读，不解析 description）、ComfyUI 工作流（music3-pack/workflows/*.json）、
   Live2D 模型配置（pet-pack/models/ 下的 .json，部件显示名是第三方素材原样）。 */
function packPackageJsonRels() {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of ents) {
      if (SKIP_DIRS.has(it.name) || it.name.startsWith(".")) continue;
      const full = path.join(dir, it.name);
      const r = rel ? rel + "/" + it.name : it.name;
      if (it.isDirectory()) walk(full, r);
      else if (it.name === "package.json") out.push(r);
    }
  };
  for (const pack of packDirs) walk(path.join(ROOT, pack), pack);
  return out.sort();
}
const packManifestRels = packDirs
  .map((p) => p + "/manifest.json")
  .filter((rel) => fs.existsSync(abs(rel)))
  .concat(packPackageJsonRels());
ok(packManifestRels.length >= 8, "[14] 扫到 " + packManifestRels.length + " 份随包清单（低于下限说明发现逻辑空转了）");
ok(
  packManifestRels.indexOf("llama-pack/manifest.json") >= 0,
  "[14] llama-pack/manifest.json 在覆盖集里（历史故障点）",
);
ok(
  packManifestRels.filter((r) => /\/package\.json$/.test(r)).length >= 2,
  "[14] `*-pack/**` 的 package.json 也进了覆盖集（npm 子进程读的那一类）",
);
/** 逐字节查一份清单：返回 {rel, bytes, nonAscii:[偏移…], boms, parses}。
 *  真源只此一份 —— 下面的自检直接复用，保证「夹具会报红」与「仓库全绿」同源。 */
function scanAsciiJson(rel, buf) {
  const nonAscii = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) nonAscii.push(i);
  const boms = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ||
    (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)));
  let parses = true;
  try {
    JSON.parse(buf.toString("utf8"));
  } catch {
    parses = false;
  }
  return { rel, bytes: buf.length, nonAscii, boms: !!boms, parses };
}
for (const rel of packManifestRels) {
  const r = scanAsciiJson(rel, bytes(rel));
  ok(
    r.nonAscii.length === 0,
    "[14] " + rel + " 零非 ASCII（违规字节 " + r.nonAscii.length +
      (r.nonAscii.length ? "，首个在偏移 " + r.nonAscii[0] : "") + "）",
  );
  ok(!r.boms, "[14] " + rel + " 无 BOM（PS 5.1 解析路径上只认纯 ASCII 无 BOM）");
  ok(r.parses, "[14] " + rel + " 仍是合法 JSON（去中文不能把 JSON 改坏）");
}
/* 覆盖集不许被无声改窄：这几份清单必须都在名单里 */
for (const rel of ["llama-pack/manifest.json", "music3-pack/manifest.json", "h3-pack/manifest.json", "yue-pack/manifest.json", "sensenova-pack/manifest.json", "breeze-pack/manifest.json", "pet-pack/manifest.json", "remotion-pack/package.json", "pet-pack/package.json"]) {
  ok(packManifestRels.indexOf(rel) >= 0, "[14] 覆盖到 " + rel);
}
/* 自检：判据必须真会报红、也真不误报（拿临时夹具，同一份 scanAsciiJson） */
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-packjson-"));
  try {
    const zh = path.join(fx, "zh.json");
    const en = path.join(fx, "en.json");
    /* 中文清单：这正是历史上 llama-pack/manifest.json 的形状 */
    fs.writeFileSync(zh, '{ "title": { "zh": "\u672c\u5730\u6a21\u578b" } }\n', "utf8");
    fs.writeFileSync(en, '{ "title": { "zh": "Local Models", "en": "Local Models" } }\n', "utf8");
    const badScan = scanAsciiJson("(fixture-zh)", fs.readFileSync(zh));
    const goodScan = scanAsciiJson("(fixture-en)", fs.readFileSync(en));
    ok(badScan.nonAscii.length > 0, "[14] 自检：带中文的清单会被本节的判据抓出来（" + badScan.nonAscii.length + " 个非 ASCII 字节）");
    ok(goodScan.nonAscii.length === 0 && goodScan.parses, "[14] 自检：纯 ASCII 清单不再误报（0 个非 ASCII 字节且 JSON 可解析）");
    const broken = path.join(fx, "broken.json");
    fs.writeFileSync(broken, '{ "a": 1, }\n', "utf8");
    ok(!scanAsciiJson("(fixture-broken)", fs.readFileSync(broken)).parses, "[14] 自检：JSON 被改坏时也会报红（不只查字节，也真解析）");
  } finally {
    try {
      fs.rmSync(fx, { recursive: true, force: true });
    } catch {}
  }
}

/* 守卫自检：拿两个**临时夹具**证明它真的会报红 —— 只断言「现在全绿」是不够的，
   正则写歪（比如忘了匹配续行）时会静默放过，这一条把那种空转钉住。 */
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-readenc-"));
  try {
    const bad = path.join(fx, "bad.ps1");
    const good = path.join(fx, "good.ps1");
    fs.writeFileSync(bad, 'Step "x" 1\r\n$m = Get-Content manifest.json -Raw | ConvertFrom-Json\r\n', "utf8");
    fs.writeFileSync(good, 'Step "x" 1\r\n$m = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json\r\n', "utf8");
    const scan = (p) => scanReadCalls("(fixture)", fs.readFileSync(p, "utf8"), []);
    ok(scan(bad).length === 1, "[13] 自检：没写 -Encoding 的读法会被本节的判据抓出来（1 处）");
    ok(scan(good).length === 0, "[13] 自检：写了 -Encoding UTF8 的读法不再误报（0 处）");
  } finally {
    try {
      fs.rmSync(fx, { recursive: true, force: true });
    } catch {}
  }
}

cleanMachineRun().then(
  () => {
    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
    process.exit(fails ? 1 : 0);
  },
  (e) => {
    checks++;
    fails++;
    console.log("  FAIL [12] 真跑探针异常：" + ((e && e.message) || e));
    console.log("\nFAILED " + fails + " / " + checks + " checks");
    process.exit(1);
  },
);
