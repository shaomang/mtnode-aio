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
const os = require("os");
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
    markers: ["[music3-setup]", "--system-site-packages", ".cuda-python", "MT_MUSIC_PIP_INDEX"],
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
    markers: ["[h3-setup]", ".cuda-python", "MT_H3_PIP_INDEX", "patch_h3_autogrow_refs.py"],
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
/* BOM 逐个文件都查：它本身是 ASCII 范围内的字节（EF BB BF 里的 BF > 0x7F 会被上面抓到，
   但 BOM 的存在还会让 PS 5.1 走 UTF-8 解码这条路，两种解码行为不一致，所以单独钉住）。 */
for (const f of ALL) {
  ok(!read(f.rel).includes("\uFEFF"), f.rel + " 无 BOM");
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
  /* 占位符：模板里的 {key} 必须真被脚本传进来（tail 允许空，其余必须有值来源） */
  for (const [code, hit] of Object.entries(table)) {
    if (!codes.includes(code)) continue;
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

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
