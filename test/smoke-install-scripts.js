"use strict";
/* 本地后端安装脚本「中文清零」—— 冒烟测试（Node + 只读调 PowerShell 解析器）
 *   node test/smoke-install-scripts.js
 *
 * 为什么要有这只用例（2026-10 的真实故障）：
 *   宿主一律用 `powershell.exe`（Windows PowerShell 5.1）跑这些安装脚本。脚本原本是
 *   **UTF-8 无 BOM + 大量中文**，而 PS 5.1 在中文 Windows 上按 ANSI(GBK / cp936) 解码
 *   无 BOM 的 .ps1 —— 中文被解成乱码字节，还会把紧跟其后的 `}` `'` `"` 当 trail byte 吞掉，
 *   于是语法直接崩。改前实测：breeze 10 处、sensenova 113 处、yue 42 处、tts 15 处、
 *   llama 3 处、h3/download_models 6 处、h3/repair_torch_kitchen 1 处语法错
 *   （同一批文件用 UTF-8 解析则 0 错）。乱码还有第二个来源：脚本/原生工具（pip / git /
 *   python）的输出在中文 Windows 上按 cp936 编码，而宿主用 `d.toString()`（UTF-8）解码。
 *   现在的口径：脚本**纯 ASCII 英文**（零非 ASCII ⇒ GBK 解码与 UTF-8 解码结果完全一致，
 *   语法不可能再因编码而崩），并在开头把本进程与子进程的输出编码钉死成 UTF-8。
 *
 * 覆盖：
 *   [1] 零非 ASCII：19 个脚本 / 辅助文件每个字节 <= 0x7F（.ps1 / .py / .cmd 全含）
 *   [2] 解析真跑：每个 .ps1 按 GBK(cp936) 解码后解析 = 0 错，按 UTF-8 解码后解析 = 0 错
 *                 （GBK 路径就是中文 Windows 上 PS 5.1 的真实解码路径）
 *   [3] 契约仍在：宿主正则抓的进度前缀、reason= 短码、标记文件名、参数 / 环境变量名、
 *                 镜像 URL、脚本里被其它冒烟断言的字样
 *   [4] 编码钉死：.ps1 有 [Console]::OutputEncoding + PYTHONIOENCODING；.cmd 有 chcp 65001
 */
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
    rel: "tts-pack/scripts/install.ps1",
    markers: ["[tts-install] progress:", ".install-ok", "GPT-SoVITS", "lj1995/GPT-SoVITS", "ghproxy.com"],
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
  { rel: "tts-pack/start_backend.cmd", markers: ["-m app"] },
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

/* ---------------- [7] 原生命令写 stderr 不许再中止 tts 安装（真机实测踩过） ----------------
   现象（2026-xx 用户报的安装现场）：宿主用 powershell.exe（Windows PowerShell 5.1）跑
   tts-pack/scripts/install.ps1，脚本第 11 行是 $ErrorActionPreference = "Stop"，克隆那一步写成
     & git clone --depth 1 $cloneUrl $engineDir 2>&1 | Out-Host
   git 把 "Cloning into ..." 这种正常信息写 stderr，Stop 口径下 PS 5.1 把它当**终止性错误**
   （RemoteException / NativeCommandError），脚本当场死在那一行：既没有
   "that clone failed, trying the next mirror"，也没有 Step-Fail，安装窗只停在 progress 48。
   修法：所有外部程序调用统一走脚本里的 Invoke-Native（调用期间把 $ErrorActionPreference
   设 Continue、finally 还原，成败只看退出码）。
   本块**真跑**整个安装脚本（只跑前面几步就够）：git / py / venv python 都放临时目录里垫在
   PATH 前面，git 垫片对每一个 URL 都只往 stderr 写一句 fatal 再回 128（完全不出网），
   https_proxy 指到一个立刻失败的地址（权重那一段也不真的出网）。
   要证明的事：第一个镜像失败后脚本**继续往下试**、五个 URL 全部试完、每个 URL 都留下了
   git 的真实 stderr（没有被压成 RemoteException 一行）、最后干净地报「克隆失败」而不是
   死在半路；同时 venv / pip 两步照样按退出码判定（包装器没把正常的 pip 流程改坏）。 */
console.log("\n[7] 真跑 tts 安装脚本：git 往 stderr 写正常信息不再中止（本地垫片，不联网）");
const TTS_PS = read("tts-pack/scripts/install.ps1");
const tmpRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "mtnode-tts-install-"));
const writeAscii = (rel, text) => {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "latin1");
};
try {
  /* 局部选一个能用的 PowerShell 来跑（宿主在 win 上就是 powershell.exe） */
  const psExe = (() => {
    for (const exe of ["powershell.exe", "pwsh"]) {
      const probe = spawnSync(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        { encoding: "utf8", windowsHide: true, timeout: 60000 },
      );
      if (!probe.error && probe.status === 0) return exe;
    }
    return "";
  })();

  if (process.platform !== "win32" || !psExe) {
    console.log("  skip  需要 Windows + PowerShell（platform=" + process.platform + "）");
  } else {
    /* git 垫片：把每次调用记下来，然后只往 stderr 写一句 fatal、退 128 —— 与真 git 克隆
       失败时的形状一样（真 git 也会把 "Cloning into ..." 写 stderr），且完全不出网。 */
    writeAscii("shim/git.cmd", [
      "@echo off",
      'echo %* >> "' + path.join(tmpRoot, "git-calls.txt") + '"',
      ">&2 echo Cloning into '%2'...",
      ">&2 echo fatal: unable to access the requested URL: The requested URL returned error: 403",
      "exit /b 128",
      "",
    ].join("\r\n"));
    writeAscii("shim/fake-py.ps1", [
      "param([Parameter(ValueFromRemainingArguments = $true)]$Rest)",
      "$all = $Rest -join ' '",
      "Add-Content -Path '" + path.join(tmpRoot, "py-calls.txt") + "' -Value $all",
      "Add-Content -Path '" + path.join(tmpRoot, "py-calls.txt") + "' -Value ('CWD=' + (Get-Location).Path)",
      "if ($all -like '*3.10*') {",
      "  [Console]::Error.WriteLine(\"Python 3.10 was not found!\")",
      "  exit 103",
      "}",
      "if ($all -like '*venv*') {",
      "  $p = Join-Path (Get-Location).Path '.venv\\Scripts'",
      "  New-Item -ItemType Directory -Force -Path $p | Out-Null",
      "  Copy-Item (Join-Path '" + path.join(tmpRoot, "stub") + "' 'stub-python.exe') (Join-Path $p 'python.exe') -Force",
      "  exit 0",
      "}",
      "Write-Host 'ok'",
      "exit 0",
      "",
    ].join("\r\n"));
    for (const shimName of ["py.cmd", "python.cmd"]) {
      writeAscii("shim/" + shimName, [
        "@echo off",
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
          path.join(tmpRoot, "shim", "fake-py.ps1") +
          "\" %*",
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"));
    }
    /* .venv\Scripts\python.exe 得是真能跑的程序（bat 垫片当 python.exe 会被 Windows 拒绝），
       所以现场用 Add-Type 编一个极小的转发器：记一笔调用（pip 那两步走的就是它），再转发给
       本机真解释器；解释器里跑一段极小的垫片，只接 venv 与 import 自检，其它一律退 0。 */
    const stubAccepts = `
import sys
if "-m" in sys.argv and "venv" in sys.argv:
    sys.exit(0)
print("ok")
sys.exit(0)
`;
    writeAscii("stub/fake_hub.py", stubAccepts);
    fs.mkdirSync(path.join(tmpRoot, "wrapper-log"), { recursive: true });
    /* 把垫片逻辑整段塞进 -c：环境变量型通道（PYTHONPATH）在 Windows Store 版 python 上不可靠，
       直接注入 sys.path 最稳；并把原始参数摆回 sys.argv，垫片才能按「脚本 -c 代码」判断意图。 */
    const stubCode = "import sys, runpy; sys.path.insert(0, r'" + path.join(tmpRoot, "stub") + "'); sys.argv = ['stub'] + " +
      "([sys.argv[1]] if len(sys.argv) > 1 else []); " +
      "runpy.run_path(r'" + path.join(tmpRoot, "stub", "fake_hub.py") + "', run_name='__main__')";
    const wrapperCs = [
      "using System;",
      "using System.IO;",
      "using System.Text;",
      "public class MTStub {",
      "  public static int Main(string[] a) {",
      "    string baseDir = AppDomain.CurrentDomain.BaseDirectory;",
      "    string logDir = Environment.GetEnvironmentVariable(\"MTSTUB_LOG\");",
      "    if (string.IsNullOrEmpty(logDir)) logDir = baseDir;",
      "    try { File.AppendAllText(Path.Combine(logDir, \"calls.txt\"), string.Join(\" \", a) + Environment.NewLine, Encoding.UTF8); }",
      "    catch (Exception ex) { try { File.AppendAllText(Path.Combine(Path.GetTempPath(), \"mtstub-err.txt\"), ex.ToString() + Environment.NewLine, Encoding.UTF8); } catch {} }",
      "    string py = FindPython();",
      "    if (py == null) { Console.Error.WriteLine(\"stub python: no real interpreter found\"); return 9; }",
      "    var psi = new System.Diagnostics.ProcessStartInfo(py);",
      // 注意：这段 C# 里不许出现 $（外层 PowerShell -Command 会把美元号吃掉一层），
      // 垫片代码改从环境变量 MTSTUB_CODE 取。
      "    string stubCode = Environment.GetEnvironmentVariable(\"MTSTUB_CODE\") ?? \"\";",
      "    psi.Arguments = \" -c \\\"\" + stubCode + \"\\\" \" + string.Join(\" \", a);",
      "    psi.UseShellExecute = false;",
      "    var p = System.Diagnostics.Process.Start(psi);",
      "    p.WaitForExit();",
      "    return p.ExitCode;",
      "  }",
      "  static string FindPython() {",
      "    string[] names = { \"python.exe\", \"python3.exe\" };",
      "    foreach (string dir in (Environment.GetEnvironmentVariable(\"PATH\") ?? \"\").Split(';')) {",
      "      if (dir.Trim().Length == 0) continue;",
      "      foreach (string n in names) {",
      "        try { string c = Path.Combine(dir.Trim(), n); if (File.Exists(c)) return c; } catch {}",
      "      }",
      "    }",
      "    return null;",
      "  }",
      "}",
      "",
    ].join("\r\n");
    writeAscii("stub/mtstub.cs", wrapperCs);
    const isFramework = /Framework/i.test(
      String(spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSEdition"], { encoding: "utf8", windowsHide: true }).stdout || ""),
    );
    const compiled = spawnSync(
      psExe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Add-Type -Path '" + path.join(tmpRoot, "stub", "mtstub.cs") + "' -OutputAssembly '" +
          path.join(tmpRoot, "stub", "stub-python.exe") + "'" +
          (isFramework ? " -OutputType ConsoleApplication" : " "),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 300000 },
    );
    if (process.env.MTNODE_TTS_SMOKE_DEBUG) {
      console.log(
        "--- Add-Type --- status=" + compiled.status + "\nstdout:\n" + String(compiled.stdout || "") +
          "\nstderr:\n" + String(compiled.stderr || ""),
      );
    }
    ok(
      !compiled.error && compiled.status === 0 && fs.existsSync(path.join(tmpRoot, "stub", "stub-python.exe")),
      "垫片解释器编译成功（Add-Type 现场编一个转发器，转发给本机真 python）",
    );
    const stubProbe = spawnSync(path.join(tmpRoot, "stub", "stub-python.exe"), ["-m", "venv", ".venv-probe"], {
      cwd: tmpRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      env: Object.assign({}, process.env, { MTSTUB_CODE: stubCode, MTSTUB_LOG: path.join(tmpRoot, "wrapper-log") }),
    });
    ok(
      !stubProbe.error && stubProbe.status === 0 &&
        fs.existsSync(path.join(tmpRoot, "wrapper-log", "calls.txt")),
      "垫片转发器自检：直接执行也能记上调用并返回 0（退出码 " + stubProbe.status + "）",
    );

    const installDir = path.join(tmpRoot, "tts");
    fs.mkdirSync(path.join(installDir, "scripts"), { recursive: true });
    /* 脚本一字不改地跑：四个镜像 + 直连 URL 全部原样（被验证的就是脚本自己那条回退链）。 */
    ok(
      ["ghfast.top", "gh-proxy.com", "ghproxy.net", "ghproxy.com"].every((h) => TTS_PS.indexOf(h) >= 0) &&
        TTS_PS.indexOf("https://github.com/RVC-Boss/GPT-SoVITS.git") >= 0,
      "脚本里四档镜像 + 直连 github 的 URL 原样保留（用例不动回退链本身）",
    );
    fs.writeFileSync(path.join(installDir, "scripts", "install.ps1"), TTS_PS, "latin1");
    fs.writeFileSync(path.join(installDir, "requirements.txt"), "# smoke stub\n", "latin1");

    const run = spawnSync(
      psExe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "install.ps1", "-InstallDir", installDir],
      {
        cwd: path.join(installDir, "scripts"),
        encoding: "utf8",
        windowsHide: true,
        timeout: 300000,
        env: Object.assign({}, process.env, {
          PATH: path.join(tmpRoot, "shim") + ";" + process.env.PATH,
          MTSTUB_CODE: stubCode,
          MTSTUB_LOG: path.join(tmpRoot, "wrapper-log"),
          HTTPS_PROXY: "http://127.0.0.1:9",
          https_proxy: "http://127.0.0.1:9",
        }),
      },
    );
    const out = String(run.stdout || "");
    const err = String(run.stderr || "");
    if (process.env.MTNODE_TTS_SMOKE_DEBUG) {
      console.log("--- stdout ---\n" + out + "\n--- stderr ---\n" + err);
    }
    const wrapperLogPath = path.join(tmpRoot, "wrapper-log", "calls.txt");
    const wrapperLog = fs.existsSync(wrapperLogPath) ? fs.readFileSync(wrapperLogPath, "utf8") : "";
    const gitCalls = fs.existsSync(path.join(tmpRoot, "git-calls.txt"))
      ? fs.readFileSync(path.join(tmpRoot, "git-calls.txt"), "utf8")
      : "";
    const gitClones = gitCalls.split(/\r?\n/).filter((s) => s.indexOf("clone") >= 0);

    /* 改前的失败形状：脚本停在第一个镜像那一行（既没有 "trying the next mirror"，也没有 Step-Fail），
       退出码非 0 且 stderr 上是那个 NativeCommandError。改后必须一路试完五个 URL 再干净报错。 */
    ok(
      out.indexOf("that clone failed (exit code 128), trying the next mirror") >= 0,
      "第一个镜像失败后脚本继续往下试（不再被 git 的 stderr 终止）",
    );
    ok(gitClones.length === 5, "五个 URL 全部试过（git 垫片记到 " + gitClones.length + " 次克隆）");
    ok(
      ["ghfast.top", "gh-proxy.com", "ghproxy.net", "ghproxy.com"].every((h) =>
        out.indexOf("[tts-install] git clone https://" + h + "/https://github.com/RVC-Boss/GPT-SoVITS.git") >= 0,
      ) && out.indexOf("[tts-install] git clone https://github.com/RVC-Boss/GPT-SoVITS.git") >= 0,
      "五个 URL（四档镜像 + 直连）都按顺序真的发起过克隆",
    );
    ok(
      out.indexOf("Cloning into") >= 0 && out.indexOf("fatal: unable to access") >= 0 &&
        out.indexOf("RemoteException") < 0 && out.indexOf("NativeCommandError") < 0,
      "git 的 stderr 原样进了安装日志，没有被压成 RemoteException / NativeCommandError 一行",
    );
    ok(
      out.indexOf("[tts-install] command raised") < 0,
      "Invoke-Native 没有落到 catch（说明 stderr 只是在 Continue 口径下正常流过）",
    );
    ok(
      out.indexOf('"status":"fail"') >= 0 && out.indexOf("GPT-SoVITS clone failed") >= 0 && run.status !== 0,
      "克隆全失败时是**干净报错**（Step-Fail 的 fail 行 + 退出码非 0），不是半路静默中止",
    );
    ok(
      !fs.existsSync(path.join(installDir, ".install-ok")),
      "没装成就不写 .install-ok（不假成功）",
    );
    if (process.env.MTNODE_TTS_SMOKE_DEBUG) {
      console.log("--- wrapper calls(" + wrapperLog.length + ") ---\n" + wrapperLog);
      console.log("--- git calls ---\n" + gitCalls);
    }
    ok(
      wrapperLog.indexOf("venv") >= 0,
      "垫片解释器被安装脚本的 venv 步骤真调到了（转发器留痕）",
    );
    ok(
      wrapperLog.indexOf("-m pip install --upgrade pip") >= 0 && wrapperLog.indexOf("-r requirements.txt") >= 0,
      "pip 的升级自身与装 requirements 两步都真跑到了（都经 venv python，退出码都检查）",
    );
    const pyLog = fs.existsSync(path.join(tmpRoot, "py-calls.txt"))
      ? fs.readFileSync(path.join(tmpRoot, "py-calls.txt"), "utf8")
      : "";
    ok(pyLog.indexOf("-3.10") >= 0, "Python 探测真的先试了 3.10（失败后按退出码换下一个）");
    ok(
      out.indexOf("Python 3.10 was not found!") < 0,
      "探测失败的 stderr 被 -Quiet 吞掉：不把「这个版本没装」当成失败噪音打给用户",
    );
    ok(
      !/^\s*&\s+(git|py|python|\$venvPy)/m.test(TTS_PS.slice(TTS_PS.indexOf("$code = $LASTEXITCODE"))),
      "包装器之外不再有裸的原生命令调用（一律走 Invoke-Native）",
    );
  }
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    /* 清理失败不影响判据 */
  }
}

/* ---------------- [8] reqs-fixups.json 是唯一真源：requirements-train.txt 的替换真生效 ----------------
   pyopenjtalk 与 jieba_fast 上游都只有源码包（前者要 MSVC 编 C 扩展，后者的 tar.gz 里 setup.py
   无条件编扩展），Windows 上装不进 .venv。现在的口径：两个生成器（安装脚本的 torch 步骤、
   训练时的自愈）都读同一份 tts-pack/reqs-fixups.json —— pyopenjtalk 整行换成 pyopenjtalk-plus，
   jieba_fast 交给本地垫片（tts-pack/shims，训练/推理子进程把它摆在 PYTHONPATH 最前）。
     [8.1] 静态：两边都读这份清单，且都不再写死裸的需求行 / 替换表（写死过 ⇒ 两边漂移）。
     [8.2] 功能：垫片真跑整只 install.ps1（git 垫片第一个 URL 就成功并造出 engine/api_v2.py，
           pip 垫片记录参数并退 0，权重文件预先摆好 ⇒ 全程不出网），检查生成的
           requirements-train.txt 与日志里的替换 / 垫片记录。
     [8.3] 垫片自检：不联网把假 jieba 注入 sys.path，tts-pack/shims 里的 jieba_fast 与
           jieba_fast.posseg 必须转出引擎要的 setLogLevel / lcut / cut_for_search / posseg.lcut。 */
console.log("\n[8] reqs-fixups.json 单一真源：requirements-train.txt 里的替换真的生效");

/* ---- [8.1] 静态：两个生成器都读清单，且不再写死裸需求行 ---- */
const TTS_TRAIN_PY = read("tts-pack/app/train.py");
const FIXUPS = (() => {
  try {
    return JSON.parse(read("tts-pack/reqs-fixups.json"));
  } catch (e) {
    return null;
  }
})();
ok(!!FIXUPS && !!FIXUPS.replacements && Array.isArray(FIXUPS.shims), "tts-pack/reqs-fixups.json 可解析且带 replacements / shims");
ok(
  !!FIXUPS && FIXUPS.replacements && FIXUPS.replacements.pyopenjtalk === "pyopenjtalk-plus>=0.4.1.post9",
  "清单里 pyopenjtalk -> pyopenjtalk-plus>=0.4.1.post9",
);
ok(!!FIXUPS && !!FIXUPS.replacements && "jieba_fast" in FIXUPS.replacements && FIXUPS.replacements.jieba_fast === null, "清单里 jieba_fast -> null（本地垫片提供，绝不发给 pip）");
ok(!!FIXUPS && Array.isArray(FIXUPS.shims) && FIXUPS.shims.indexOf("jieba_fast") >= 0, "清单的 shims 记着 jieba_fast（对应 tts-pack/shims/jieba_fast）");
has(TTS_PS, '$fixupsPath = Join-Path $InstallDir "reqs-fixups.json"', "install.ps1 从安装目录读同一份清单");
has(TTS_PS, "ConvertFrom-Json", "install.ps1 真解析这份清单");
has(TTS_PS, "$fixups.dropPrefixes", "install.ps1 的丢弃前缀取自清单（不写死）");
has(TTS_PS, "$fixups.replacements", "install.ps1 的行替换取自清单（不写死）");
has(TTS_PS, "$fixups.shims", "install.ps1 的垫片清单纯取自清单（不写死）");
has(TTS_TRAIN_PY, 'fx_path = ROOT / "reqs-fixups.json"', "app/train.py 的清单路径（ROOT = tts-pack）");
has(TTS_TRAIN_PY, "json.loads(fx_path.read_text", "app/train.py 也解析这份清单");
has(TTS_TRAIN_PY, 'fx.get("dropPrefixes")', "app/train.py 的丢弃前缀取自清单");
has(TTS_TRAIN_PY, 'fx.get("replacements")', "app/train.py 的行替换取自清单");
/* 裸需求行 = 把包名原样交给 pip 的那一行。install.ps1 里连带引号的清单字面量都不该有
   （清单已抽走）；train.py 只在「清单读不到」的内置兜底里出现这两个名字，且兜底值同样是修好的。 */
ok(!/["']pyopenjtalk["']/.test(TTS_PS), "install.ps1 里没有写死的 pyopenjtalk 替换项");
ok(!/["']jieba_fast["']/.test(TTS_PS), "install.ps1 里没有写死的 jieba_fast 垫片项");
ok(!/["'](gradio|funasr|onnxruntime|modelscope)["']/.test(TTS_PS), "install.ps1 里没有写死的丢弃前缀");
ok(!/^\s*["']?(pyopenjtalk|jieba_fast)["']?\s*$/m.test(TTS_PS), "install.ps1 里没有裸的 pyopenjtalk / jieba_fast 需求行");
ok(!/^\s*["']?pyopenjtalk["']?\s*(>=|==|~=|<=)/m.test(TTS_PS), "install.ps1 里没有裸的 pyopenjtalk 版本需求行");
ok(!/^\s*["']?(pyopenjtalk|jieba_fast)["']?\s*$/m.test(TTS_TRAIN_PY), "app/train.py 里没有裸的 pyopenjtalk / jieba_fast 需求行");
ok(!/^\s*["']?pyopenjtalk["']?\s*(>=|==|~=|<=)/m.test(TTS_TRAIN_PY), "app/train.py 里没有裸的 pyopenjtalk 版本需求行");
has(TTS_TRAIN_PY, '"pyopenjtalk": "pyopenjtalk-plus>=0.4.1.post9"', "train.py 内置兜底里 pyopenjtalk 也是换成 pyopenjtalk-plus");
has(TTS_TRAIN_PY, '"jieba_fast": None', "train.py 内置兜底里 jieba_fast 也走垫片（不进 pip）");

/* ---- [8.2] 功能：垫片真跑整只 install.ps1，检查它生成的 requirements-train.txt ---- */
console.log("[8.2] 真跑 install.ps1：git 垫片第一个 URL 就成功、pip 垫片记录参数并退 0、权重预置 ⇒ 不出网");
const tmp2 = fs.mkdtempSync(path.join(require("os").tmpdir(), "mtnode-tts-fixups-"));
const writeAscii2 = (rel, text) => {
  const p = path.join(tmp2, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "latin1");
};
try {
  const psExe2 = (() => {
    for (const exe of ["powershell.exe", "pwsh"]) {
      const probe = spawnSync(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        { encoding: "utf8", windowsHide: true, timeout: 60000 },
      );
      if (!probe.error && probe.status === 0) return exe;
    }
    return "";
  })();

  if (process.platform !== "win32" || !psExe2) {
    console.log("  skip  需要 Windows + PowerShell（platform=" + process.platform + "）");
  } else {
    /* 假引擎 requirements：就是真实 GPT-SoVITS requirements.txt 里会被丢弃 / 替换的那几行，
       外加几行必须原样保留的（numpy<2.0 / scipy / jieba / opencc）。 */
    const ENGINE_REQ_LINES = [
      "--no-binary=opencc",
      "numpy<2.0",
      "scipy",
      "librosa==0.10.2",
      "gradio<5",
      'onnxruntime-gpu; platform_machine == "x86_64" or platform_machine == "AMD64"',
      "funasr>=1.3.7",
      "cn2an",
      "pyopenjtalk>=0.4.1",
      "g2p_en",
      "jieba_fast",
      "jieba",
      "transformers>=4.51,<5",
      "modelscope",
      "fastapi[standard]>=0.115.2",
      "opencc",
    ];
    writeAscii2("templates/engine-requirements.txt", ENGINE_REQ_LINES.join("\r\n") + "\r\n");
    writeAscii2("templates/api_v2.py", "# smoke stub: the git shim 'cloned' this file\r\n");
    /* git 垫片：第一次调用（第一档镜像 ghfast.top）就成功 —— 把 api_v2.py 与假 requirements.txt
       摆进目标 engine 目录（脚本拿 Test-Path api_v2.py 判定克隆成功），stderr 上照旧写一句
       "Cloning into ..."（真 git 也这么写），退 0。 */
    writeAscii2("shim/git.cmd", [
      "@echo off",
      'echo %* >> "' + path.join(tmp2, "git-calls.txt") + '"',
      'copy /y "' + path.join(tmp2, "templates", "api_v2.py") + '" "%~5\\api_v2.py" >nul',
      'copy /y "' + path.join(tmp2, "templates", "engine-requirements.txt") + '" "%~5\\requirements.txt" >nul',
      ">&2 echo Cloning into '%~5'...",
      "exit /b 0",
      "",
    ].join("\r\n"));
    /* py / python 垫片：与 [7] 同一套（3.10 探测失败 ⇒ 换 3.11；venv 步骤造出 .venv\Scripts\python.exe） */
    writeAscii2("shim/fake-py.ps1", [
      "param([Parameter(ValueFromRemainingArguments = $true)]$Rest)",
      "$all = $Rest -join ' '",
      "Add-Content -Path '" + path.join(tmp2, "py-calls.txt") + "' -Value $all",
      "if ($all -like '*3.10*') {",
      "  [Console]::Error.WriteLine(\"Python 3.10 was not found!\")",
      "  exit 103",
      "}",
      "if ($all -like '*venv*') {",
      "  $p = Join-Path (Get-Location).Path '.venv\\Scripts'",
      "  New-Item -ItemType Directory -Force -Path $p | Out-Null",
      "  Copy-Item (Join-Path '" + path.join(tmp2, "stub") + "' 'stub-python.exe') (Join-Path $p 'python.exe') -Force",
      "  exit 0",
      "}",
      "Write-Host 'ok'",
      "exit 0",
      "",
    ].join("\r\n"));
    for (const shimName of ["py.cmd", "python.cmd"]) {
      writeAscii2("shim/" + shimName, [
        "@echo off",
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
          path.join(tmp2, "shim", "fake-py.ps1") +
          "\" %*",
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"));
    }
    /* .venv\Scripts\python.exe 得是真能跑的程序（bat 垫片当 python.exe 会被 Windows 拒绝），
       所以现场编一个转发器：把每次调用（pip 那几步走的就是它）记一笔，再转发给本机真解释器；
       解释器里跑一段极小的垫片，一切参数都退 0 —— 也就是「pip 垫片记录参数并退 0」。 */
    writeAscii2("stub/fake_hub.py", `
import sys
if "-m" in sys.argv and "venv" in sys.argv:
    sys.exit(0)
print("ok")
sys.exit(0)
`);
    fs.mkdirSync(path.join(tmp2, "wrapper-log"), { recursive: true });
    const stubCode2 =
      "import sys, runpy; sys.path.insert(0, r'" + path.join(tmp2, "stub") + "'); sys.argv = ['stub'] + " +
      "([sys.argv[1]] if len(sys.argv) > 1 else []); " +
      "runpy.run_path(r'" + path.join(tmp2, "stub", "fake_hub.py") + "', run_name='__main__')";
    const wrapperCs2 = [
      "using System;",
      "using System.IO;",
      "using System.Text;",
      "public class MTStub {",
      "  public static int Main(string[] a) {",
      "    string baseDir = AppDomain.CurrentDomain.BaseDirectory;",
      "    string logDir = Environment.GetEnvironmentVariable(\"MTSTUB_LOG\");",
      "    if (string.IsNullOrEmpty(logDir)) logDir = baseDir;",
      "    try { File.AppendAllText(Path.Combine(logDir, \"calls.txt\"), string.Join(\" \", a) + Environment.NewLine, Encoding.UTF8); }",
      "    catch (Exception ex) { try { File.AppendAllText(Path.Combine(Path.GetTempPath(), \"mtstub-err.txt\"), ex.ToString() + Environment.NewLine, Encoding.UTF8); } catch {} }",
      "    string py = FindPython();",
      "    if (py == null) { Console.Error.WriteLine(\"stub python: no real interpreter found\"); return 9; }",
      "    var psi = new System.Diagnostics.ProcessStartInfo(py);",
      "    string stubCode = Environment.GetEnvironmentVariable(\"MTSTUB_CODE\") ?? \"\";",
      "    psi.Arguments = \" -c \\\"\" + stubCode + \"\\\" \" + string.Join(\" \", a);",
      "    psi.UseShellExecute = false;",
      "    var p = System.Diagnostics.Process.Start(psi);",
      "    p.WaitForExit();",
      "    return p.ExitCode;",
      "  }",
      "  static string FindPython() {",
      "    string[] names = { \"python.exe\", \"python3.exe\" };",
      "    foreach (string dir in (Environment.GetEnvironmentVariable(\"PATH\") ?? \"\").Split(';')) {",
      "      if (dir.Trim().Length == 0) continue;",
      "      foreach (string n in names) {",
      "        try { string c = Path.Combine(dir.Trim(), n); if (File.Exists(c)) return c; } catch {}",
      "      }",
      "    }",
      "    return null;",
      "  }",
      "}",
      "",
    ].join("\r\n");
    writeAscii2("stub/mtstub.cs", wrapperCs2);
    const isFramework2 = /Framework/i.test(
      String(spawnSync(psExe2, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSEdition"], { encoding: "utf8", windowsHide: true }).stdout || ""),
    );
    const compiled2 = spawnSync(
      psExe2,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Add-Type -Path '" + path.join(tmp2, "stub", "mtstub.cs") + "' -OutputAssembly '" +
          path.join(tmp2, "stub", "stub-python.exe") + "'" +
          (isFramework2 ? " -OutputType ConsoleApplication" : " "),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 300000 },
    );
    ok(
      !compiled2.error && compiled2.status === 0 && fs.existsSync(path.join(tmp2, "stub", "stub-python.exe")),
      "垫片解释器编译成功（pip 那几步都经它，参数记进 wrapper-log/calls.txt）",
    );

    /* 权重文件全部预置：权重那一步每个文件 Test-Path 命中就 continue ⇒ 全程一个请求都不发。
       文件清单直接从脚本里读出来，脚本改了权重列表这里不会漏。
       行内字段顺序不作为判据：逐行取 out（落盘相对路径），再从头里读镜像路径字段。 */
    const weightOuts = [];
    const weightLines = [];
    for (const line of TTS_PS.split(/\r?\n/)) {
      /* 头里可含内层分隔（must = $true;），所以取到行尾的最后一个 }, 为止（末条无尾逗号）；
         行尾注释（# 或 //）不算正文 */
      const m = /^\s*@\{(.+)\},?\s*(?:(?:\/\/|#).*)?$/.exec(line);
      if (!m) continue;
      const out = /out\s*=\s*"([^"]+)"/.exec(m[1]);
      if (out) {
        weightOuts.push(out[1]);
        weightLines.push(m[1]);
      }
    }
    ok(weightOuts.length >= 6, "从安装脚本里读出 " + weightOuts.length + " 个权重文件（预置它们 = 权重那一步不出网）");
    /* 每条权重都得说清「在哪个镜像的哪个路径」：ms = 魔搭镜像仓（pretrained_models/ 下）、
       hf = lj1995/GPT-SoVITS、hfl = 上游 chinese-roberta-wwm-ext-large（vocab.txt 只在那儿）。
       至少有一条镜像路径，否则这条权重永远下不下来。 */
    const noSource = weightLines.filter((l) => !/(?:^|[;{]\s*)(?:ms|hf|hfl)\s*=\s*"[^"]+"/.test(l));
    ok(
      weightLines.length === weightOuts.length && noSource.length === 0,
      "每条权重都带镜像路径（ms / hf / hfl 至少一个）；缺的：" + (noSource.length ? noSource.join(" | ") : "无"),
    );
    const withMs = weightLines.filter((l) => /(?:^|[;{]\s*)ms\s*=\s*"[^"]+"/.test(l));
    ok(
      withMs.length >= 6,
      "绝大多数权重能直接从魔搭镜像仓取（只有上游独有的文件才没有 ms 路径）：" + withMs.length + "/" + weightLines.length,
    );
    /* 反例自检：老写法把「引擎里的相对路径」当远端路径（GPT_SoVITS/pretrained_models/<文件>），
       那两个仓里都没有这种名字 ⇒ 每个文件都 404。判据别退化成「只要列了文件就行」。 */
    ok(
      weightOuts.every((o) => !/^GPT_SoVITS\//.test(o)) && !/^(?:ms|hf)\s*=\s*"GPT_SoVITS\//m.test(TTS_PS),
      "权重远端路径不再是引擎内的相对路径（GPT_SoVITS/pretrained_models/... 在两个仓里都不存在）",
    );
    /* 两个镜像仓的基址也要钉住：魔搭那条的仓 id 是 lj1995/GPT-SoVITS 之外的那个（存在、且文件在
       pretrained_models/ 下）；lj1995/GPT-SoVITS 只在 hf-mirror 那一侧才有。 */
    const msRepoDefault = /else \{ "([^"]+)" \}\s*\r?\n\$msBase/.exec(TTS_PS);
    ok(
      !!msRepoDefault && msRepoDefault[1] !== "lj1995/GPT-SoVITS",
      "魔搭镜像仓 id 不是 lj1995/GPT-SoVITS（那个仓在魔搭上不存在，旧的「魔搭优先」是空跑）",
    );
    ok(
      /\$msBase = "https:\/\/www\.modelscope\.cn\/models\/\$msRepo\/resolve\/master\/pretrained_models\/"/.test(TTS_PS),
      "魔搭取文件的 URL 带上 pretrained_models/ 前缀（镜像仓的目录结构就是这样）",
    );
    ok(
      /\$hfBase = "https:\/\/hf-mirror\.com\/lj1995\/GPT-SoVITS\/resolve\/main\/"/.test(TTS_PS),
      "hf-mirror 回退取的是 lj1995/GPT-SoVITS（同一个文件在两个仓里路径一致）",
    );
    ok(
      /\$hflBase = "https:\/\/hf-mirror\.com\/hfl\/chinese-roberta-wwm-ext-large\/resolve\/main\/"/.test(TTS_PS) &&
        /out\s*=\s*"chinese-roberta-wwm-ext-large\/vocab\.txt"[^\r\n]*hfl\s*=\s*"vocab\.txt"/.test(TTS_PS),
      "中文 BERT 缺的 vocab.txt 从上游 hfl/chinese-roberta-wwm-ext-large 取（只有它有）",
    );
    ok(
      /out\s*=\s*"chinese-hubert-base\/preprocessor_config\.json"/.test(TTS_PS) &&
        /out\s*=\s*"chinese-roberta-wwm-ext-large\/tokenizer\.json"/.test(TTS_PS),
      "HuBERT 的 preprocessor_config.json 与 BERT 的 tokenizer.json 也在清单里（缺了 transformers 加载直接失败）",
    );
    ok(
      !/hf_hub_download/.test(TTS_PS),
      "权重不再走 huggingface_hub（它只把文件写进 <local_dir>/<repo_id>/ 嵌套目录，引擎根本不看那里）",
    );
    const installDir2 = path.join(tmp2, "tts");
    for (const rel of weightOuts) {
      const p = path.join(installDir2, "engine", "GPT_SoVITS", "pretrained_models", rel.split("/").join(path.sep));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "smoke stub weight\n", "latin1");
    }
    /* 安装目录摆成宿主 syncPackToInstall 之后的形状：脚本 + 清单 + 垫片 + requirements.txt
       （清单缺席时脚本会 Step-Fail，所以必须照真实安装后的样子摆上） */
    fs.mkdirSync(path.join(installDir2, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(installDir2, "scripts", "install.ps1"), TTS_PS, "latin1");
    fs.copyFileSync(abs("tts-pack/reqs-fixups.json"), path.join(installDir2, "reqs-fixups.json"));
    fs.cpSync(abs("tts-pack/shims"), path.join(installDir2, "shims"), { recursive: true });
    fs.writeFileSync(path.join(installDir2, "requirements.txt"), "# smoke stub\n", "latin1");

    const run2 = spawnSync(
      psExe2,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "install.ps1", "-InstallDir", installDir2],
      {
        cwd: path.join(installDir2, "scripts"),
        encoding: "utf8",
        windowsHide: true,
        timeout: 300000,
        env: Object.assign({}, process.env, {
          PATH: path.join(tmp2, "shim") + ";" + process.env.PATH,
          MTSTUB_CODE: stubCode2,
          MTSTUB_LOG: path.join(tmp2, "wrapper-log"),
          HTTPS_PROXY: "http://127.0.0.1:9",
          https_proxy: "http://127.0.0.1:9",
        }),
      },
    );
    const out2 = String(run2.stdout || "");
    const err2 = String(run2.stderr || "");
    if (process.env.MTNODE_TTS_SMOKE_DEBUG) {
      console.log("--- [8.2] stdout ---\n" + out2 + "\n--- [8.2] stderr ---\n" + err2);
    }
    const trainReqPath = path.join(installDir2, "engine", "requirements-train.txt");
    /* PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM（Add-Content 追加的不带），先剥掉再比对 */
    const trainTxt = fs.existsSync(trainReqPath)
      ? fs.readFileSync(trainReqPath, "utf8").replace(/\r\n/g, "\n").replace(/^\uFEFF/, "")
      : "";
    const gitCalls2 = fs.existsSync(path.join(tmp2, "git-calls.txt"))
      ? fs.readFileSync(path.join(tmp2, "git-calls.txt"), "utf8")
      : "";
    const gitClones2 = gitCalls2.split(/\r?\n/).filter((s) => s.indexOf("clone") >= 0);
    const wrapperPath2 = path.join(tmp2, "wrapper-log", "calls.txt");
    const wrapperLog2 = fs.existsSync(wrapperPath2) ? fs.readFileSync(wrapperPath2, "utf8") : "";

    ok(run2.status === 0, "整只 install.ps1 跑到最后（退出码 " + run2.status + "）");
    ok(
      out2.indexOf("[tts-install] done") >= 0 && fs.existsSync(path.join(installDir2, ".install-ok")),
      "走到最后一步、写了 .install-ok（装成即真成）",
    );
    has(out2, "[tts-install] requirements fixups from " + path.join(installDir2, "reqs-fixups.json"), "日志说明替换表来自 reqs-fixups.json");
    has(out2, "[tts-install] reqs fixup: pyopenjtalk -> pyopenjtalk-plus>=0.4.1.post9", "日志里的行替换记录");
    has(out2, "[tts-install] reqs fixup: jieba_fast -> local shim (tts-pack/shims/jieba_fast), not sent to pip", "日志里的垫片记录");
    ok(
      gitClones2.length === 1 && gitCalls2.indexOf("ghfast.top") >= 0,
      "第一档镜像就成功，没有再试后面四档（克隆 " + gitClones2.length + " 次）",
    );
    has(trainTxt, "pyopenjtalk-plus>=0.4.1.post9", "requirements-train.txt 里 pyopenjtalk 换成了 pyopenjtalk-plus");
    ok(trainTxt.indexOf("pyopenjtalk>=") < 0, "requirements-train.txt 不含 pyopenjtalk>= 原行");
    ok(!/^pyopenjtalk(\s|$|>=|==|~=|<=)/m.test(trainTxt), "requirements-train.txt 不含裸 pyopenjtalk 需求行");
    ok(trainTxt.indexOf("jieba_fast") < 0, "requirements-train.txt 里没有 jieba_fast（垫片提供，绝不发给 pip）");
    ok(
      !/^(--no-binary|gradio|funasr|modelscope)/m.test(trainTxt) &&
        trainTxt.indexOf("onnxruntime-gpu") < 0 &&
        trainTxt.indexOf("fastapi[standard]") < 0,
      "丢弃前缀行全被丢掉（--no-binary / gradio / funasr / modelscope / onnxruntime-gpu / fastapi[standard]）",
    );
    ok(
      /^numpy<2\.0$/m.test(trainTxt) && /^scipy$/m.test(trainTxt) && /^jieba$/m.test(trainTxt) && /^opencc$/m.test(trainTxt),
      "不相干的行原样保留（numpy<2.0 / scipy / jieba / opencc）",
    );
    ok(
      /^pandas$/m.test(trainTxt) && /^matplotlib$/m.test(trainTxt) && /^torch-einops-utils$/m.test(trainTxt) &&
        /^loguru$/m.test(trainTxt) && /^onnxruntime$/m.test(trainTxt) && /^faster-whisper$/m.test(trainTxt),
      "引擎要用但 requirements 里没有的包照旧补上（pandas / matplotlib / torch-einops-utils / loguru / onnxruntime / faster-whisper）",
    );
    ok(
      wrapperLog2.indexOf("-m pip install -r " + trainReqPath) >= 0,
      "pip 垫片真被调到、参数就是生成的 requirements-train.txt（退出码 0，脚本才继续往下）",
    );
    ok(
      /* 单个权重文件那条是 "[tts-install] downloading <名字> (i/n)..."，只认它 */
      !/\[tts-install\] downloading .+ \(\d+\/\d+\)/.test(out2) &&
        out2.indexOf("modelscope failed") < 0 &&
        out2.indexOf("warn: failed") < 0,
      "权重那一步一个文件都没下载（预置命中 ⇒ 全程不出网，判据也不受网络影响）",
    );
    has(out2, "[tts-install] smoke: import pyopenjtalk + jieba_fast", "最后那步「两个包必须能 import」也跑了");
  }
} finally {
  try {
    fs.rmSync(tmp2, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    /* 清理失败不影响判据 */
  }
}

/* ---- [8.3] 垫片自检：假 jieba 注入 sys.path，tts-pack/shims/jieba_fast 必须转出引擎要的 API ---- */
console.log("[8.3] 垫片自检（不联网）：假 jieba 注入 sys.path，jieba_fast / jieba_fast.posseg 转出引擎那套 API");
const tmp3 = fs.mkdtempSync(path.join(require("os").tmpdir(), "mtnode-jieba-shim-"));
try {
  const fakeLibs = path.join(tmp3, "fakelibs");
  fs.mkdirSync(path.join(fakeLibs, "jieba"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeLibs, "jieba", "__init__.py"),
    [
      "# smoke stub: stand-in for the real jieba (the shim must forward 1:1)",
      '__version__ = "0.0.0-fake"',
      "",
      "",
      "def _mk(name):",
      "    def _f(*a, **k):",
      '        return "fake:" + name',
      "    _f.__name__ = name",
      "    return _f",
      "",
      "",
      "for _n in (",
      '    "initialize", "setLogLevel", "cut", "lcut", "cut_for_search", "lcut_for_search",',
      '    "tokenize", "add_word", "del_word", "suggest_freq", "load_userdict",',
      '    "set_dictionary", "get_dict_file", "get_FREQ", "enable_parallel", "disable_parallel",',
      "):",
      "    globals()[_n] = _mk(_n)",
      "",
      'dt = "fake-dt"',
      "",
    ].join("\n"),
    "latin1",
  );
  fs.writeFileSync(
    path.join(fakeLibs, "jieba", "posseg.py"),
    [
      "# smoke stub: stand-in for the real jieba.posseg",
      "",
      "",
      "def _mk(name):",
      "    def _f(*a, **k):",
      '        return "fake:posseg:" + name',
      "    _f.__name__ = name",
      "    return _f",
      "",
      "",
      'for _n in ("initialize", "cut", "lcut"):',
      "    globals()[_n] = _mk(_n)",
      "",
      'pair = "fake-pair"',
      'POSTokenizer = "fake-POSTokenizer"',
      'dt = "fake-posseg-dt"',
      "",
    ].join("\n"),
    "latin1",
  );
  const probePath = path.join(tmp3, "probe_jieba_shim.py");
  fs.writeFileSync(
    probePath,
    [
      "import json",
      "import sys",
      "",
      "# 垫片目录 + 假 jieba 目录都插在 site-packages 前面（假 jieba 更靠前）",
      "sys.path.insert(0, r'" + abs("tts-pack/shims") + "')",
      "sys.path.insert(0, r'" + fakeLibs + "')",
      "",
      "out = {}",
      "try:",
      "    import jieba_fast",
      "    import jieba_fast.posseg as psg",
      "    import jieba",
      "    import jieba.posseg as jpsg",
      "",
      '    out["shim_file"] = jieba_fast.__file__',
      '    out["version"] = jieba_fast.__version__',
      '    out["setLogLevel"] = jieba_fast.setLogLevel()',
      '    out["lcut"] = jieba_fast.lcut("x")',
      '    out["cut_for_search"] = jieba_fast.cut_for_search("x")',
      '    out["posseg_attr"] = hasattr(jieba_fast, "posseg")',
      '    out["posseg_lcut"] = psg.lcut("x")',
      '    out["pair"] = psg.pair',
      '    out["forward_attr"] = jieba_fast.tokenize()',
      '    out["same_lcut"] = jieba_fast.lcut is jieba.lcut',
      '    out["same_posseg_lcut"] = psg.lcut is jpsg.lcut',
      "except Exception as exc:",
      '    out["error"] = type(exc).__name__ + ": " + str(exc)',
      "print(json.dumps(out))",
      "",
    ].join("\n"),
    "utf8",
  );
  const pyCand = (() => {
    for (const cand of [["py", ["-3"]], ["python", []], ["python3", []]]) {
      const r = spawnSync(cand[0], cand[1].concat(["-c", "import sys"]), { encoding: "utf8", windowsHide: true, timeout: 60000 });
      if (!r.error && r.status === 0) return { exe: cand[0], args: cand[1] };
    }
    return null;
  })();
  if (!pyCand) {
    console.log("  skip  本机找不到 python 解释器（垫片自检需要它跑一次 import）");
  } else {
    const probe2 = spawnSync(pyCand.exe, pyCand.args.concat([probePath]), {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
    });
    if (process.env.MTNODE_TTS_SMOKE_DEBUG) {
      console.log("--- [8.3] stdout ---\n" + String(probe2.stdout || "") + "\n--- [8.3] stderr ---\n" + String(probe2.stderr || ""));
    }
    let res = null;
    try {
      res = JSON.parse(String(probe2.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop());
    } catch (e) {
      res = null;
    }
    ok(!!res, "探针脚本跑通并回 JSON（" + pyCand.exe + " " + pyCand.args.join(" ") + "，退出码 " + probe2.status + "）");
    if (res) {
      ok(!res.error, "import jieba_fast / jieba_fast.posseg 成功" + (res.error ? "（" + res.error + "）" : ""));
      const shimDir = path.join(abs("tts-pack/shims"), "jieba_fast");
      ok(
        String(res.shim_file || "").toLowerCase().indexOf(shimDir.toLowerCase()) === 0,
        "jieba_fast 来自 tts-pack/shims 垫片而不是别处（" + res.shim_file + "）",
      );
      ok(res.setLogLevel === "fake:setLogLevel", "jieba_fast.setLogLevel 转到真 jieba（" + res.setLogLevel + "）");
      ok(res.lcut === "fake:lcut", "jieba_fast.lcut 转到真 jieba（" + res.lcut + "）");
      ok(res.cut_for_search === "fake:cut_for_search", "jieba_fast.cut_for_search 转到真 jieba（" + res.cut_for_search + "）");
      ok(res.posseg_attr === true, "jieba_fast.posseg 可直接当属性取（chinese2.py 的用法）");
      ok(res.posseg_lcut === "fake:posseg:lcut", "jieba_fast.posseg.lcut 转到真 jieba.posseg（" + res.posseg_lcut + "）");
      ok(res.pair === "fake-pair", "posseg.pair 就是真 jieba 的对象（引擎里的 isinstance 检查不会被打断）");
      ok(res.forward_attr === "fake:tokenize", "其余属性经 __getattr__ 兜底转发（" + res.forward_attr + "）");
      ok(res.same_lcut === true && res.same_posseg_lcut === true, "转发是 1:1（lcut 与 posseg.lcut 与真 jieba 同一个函数对象）");
    }
  }
} finally {
  try {
    fs.rmSync(tmp3, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    /* 清理失败不影响判据 */
  }
}

/* ---------------- [9] 打包白名单：打包态安装目录必须拿到 reqs-fixups.json 与 shims ----------------
   实测故障（用户机 E:\mtnode-test\tts）：脚手架 .venv / engine 装好之后重跑安装，
   在 torch 步直接死：
     [tts-install] progress: 50
     reqs-fixups.json not found
     At ...\tts\scripts\install.ps1:224 char:5
     +     throw "reqs-fixups.json not found"
   根因不在脚本、也不在清单内容，而在 build.json 的 extraResources：tts-pack 的 filter（正向
   白名单，宿主 bundledPackRoot() + syncPackToInstall() 就是照它随包 / 复制的）里当时只有
   app/** scripts/** requirements.txt README.md start_backend.cmd .gitignore steps.json
   manifest.json —— 少了 reqs-fixups.json 与整个 shims/。于是**打包态**（含用户那份安装目录）
   永远缺这两样：装到 torch 步判 Test-Path 失败就抛，末尾的 smoke 步（PYTHONPATH=$InstallDir\shims）
   也注定导不进 jieba_fast / gradio 桩。开发态（从仓库跑）看不出来，因为仓库里文件是全的。
   这里的判据：清单必须随包，且 pack 里那个子集要覆盖 [8.2] 真跑 install.ps1 时实际用到的那几样
   （shims/jieba_fast/__init__.py 与 posseg.py、清单里点名的每个垫片目录）。 */
console.log("\n[9] build.json 打包白名单：reqs-fixups.json 与 shims/** 随 tts-pack 一起发");
const BUILD_CFG = (() => {
  /* 按行剥注释（不能用全局正则 —— build.json 里就有 "node_modules/*prebuilds" 这种以 /* 开头的 glob），
     再清掉尾逗号；与 test/smoke-release-git.js [5] 同一口径。 */
  const kept = [];
  let inBlock = false;
  for (const line of read("build.json").split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.indexOf("*/") >= 0) inBlock = false;
      continue;
    }
    if (t.indexOf("/*") === 0) {
      if (t.indexOf("*/") < 0) inBlock = true;
      continue;
    }
    if (t.indexOf("//") === 0) continue;
    kept.push(line);
  }
  try {
    return JSON.parse(kept.join("\n").replace(/,(\s*[\]}])/g, "$1"));
  } catch (e) {
    return null;
  }
})();
ok(!!BUILD_CFG && Array.isArray(BUILD_CFG.extraResources), "build.json 可解析且带 extraResources（注释 / 尾逗号剥干净）");
const TTS_PACK_ER =
  (BUILD_CFG && Array.isArray(BUILD_CFG.extraResources)
    ? BUILD_CFG.extraResources.filter((x) => x && x.from === "tts-pack" && x.to === "tts-pack")
    : [])[0] || null;
ok(!!TTS_PACK_ER, "extraResources 里有 tts-pack -> tts-pack 这一条");
const TTS_PACK_FILTER = (TTS_PACK_ER && Array.isArray(TTS_PACK_ER.filter) ? TTS_PACK_ER.filter : []).map((p) => String(p));
ok(TTS_PACK_FILTER.indexOf("reqs-fixups.json") >= 0, "白名单含 reqs-fixups.json（install.ps1 的 torch 步要从 $InstallDir 读它）");
ok(TTS_PACK_FILTER.indexOf("shims/**") >= 0, "白名单含 shims/**（jieba_fast 垫片 + gradio 桩，推理 / 训练子进程靠 PYTHONPATH 找它）");

const globRe = (g) =>
  new RegExp(
    "^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$",
  );
const shippedInPack = (rel) => {
  /* 与 electron-builder 的 filter 同口径：按书写顺序，正向命中 = 收，'!' 命中 = 排除。 */
  let hit = false;
  for (const p of TTS_PACK_FILTER) {
    const neg = p.charAt(0) === "!";
    const g = neg ? p.slice(1) : p;
    if (globRe(g).test(rel)) hit = !neg;
  }
  return hit;
};
const walkRel = (rootAbs) => {
  const out = [];
  for (const ent of fs.readdirSync(rootAbs, { withFileTypes: true })) {
    const rel = String(ent.name);
    if (ent.isDirectory()) for (const r of walkRel(path.join(rootAbs, ent.name))) out.push(rel + "/" + r);
    else out.push(rel);
  }
  return out;
};
const SHIM_FILES = (() => {
  try {
    return walkRel(abs("tts-pack/shims"));
  } catch (e) {
    return [];
  }
})();
for (const rel of SHIM_FILES.filter((r) => r.indexOf("__pycache__/") < 0)) ok(shippedInPack("shims/" + rel), "垫片文件随包：shims/" + rel);
ok(
  SHIM_FILES.indexOf("jieba_fast/__init__.py") >= 0 && SHIM_FILES.indexOf("jieba_fast/posseg.py") >= 0,
  "tts-pack/shims 里 jieba_fast 垫片齐（__init__.py + posseg.py，" + SHIM_FILES.length + " 个文件）",
);
ok(
  SHIM_FILES.filter((r) => r.indexOf("__pycache__/") >= 0).every((r) => !shippedInPack("shims/" + r)),
  "开发机的 __pycache__ 字节码不随包（!**/__pycache__/** 真生效）",
);
ok(shippedInPack("reqs-fixups.json"), "白名单真的把 reqs-fixups.json 收进来（glob 匹配自检）");
ok(!shippedInPack("engine/requirements.txt"), "反例自检：引擎目录不在白名单里（安装时才 clone）");

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
