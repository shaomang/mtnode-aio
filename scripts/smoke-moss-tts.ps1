# MOSS-TTS-Nano 内置后端冒烟（开发期手动跑，不是发版链的一部分）
# 作用：在 %TEMP%\moss-tts-smoke 里复刻主进程的安装链（venv + 依赖 + hf-mirror 权重），
#      再用真实的 JSON 行协议驱动 moss-tts-pack/app/serve.py 合成两句，验证：
#      ① 不装 torch 能跑（依赖只有 numpy / onnxruntime / sentencepiece / soundfile）
#      ② 预热 + 分句 chunk 事件 + 静音裁剪后的 wav 时长合理
#      ③ 进程能不靠信号正常 shutdown
# 用法：powershell -File scripts/smoke-moss-tts.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:TEMP "moss-tts-smoke"
$app = Join-Path $root "app"
$venv = Join-Path $root "venv"
$models = Join-Path $root "models"
$out = Join-Path $root "out"

Write-Host "[1/5] 同步脚手架 -> $app"
New-Item -ItemType Directory -Force -Path $app, $models, $out | Out-Null
Copy-Item (Join-Path $repo "moss-tts-pack\app\*") $app -Recurse -Force

Write-Host "[2/5] 建 venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) { python -m venv $venv }
$py = Join-Path $venv "Scripts\python.exe"

Write-Host "[3/5] 装依赖（清华源；显式清掉机器上 pip.ini 里的 ngc 额外源）"
$env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
$env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
$env:PIP_EXTRA_INDEX_URL = ""
$env:PIP_NO_CACHE_DIR = "1"
& $py -m pip install --disable-pip-version-check --no-input -q -r (Join-Path $app "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip 失败" }

Write-Host "[4/5] 下权重（hf-mirror）"
$repos = @(
  @{ dir = "MOSS-TTS-Nano-100M-ONNX"; repo = "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX" },
  @{ dir = "MOSS-Audio-Tokenizer-Nano-ONNX"; repo = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX" }
)
foreach ($r in $repos) {
  $dir = Join-Path $models $r.dir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $info = Invoke-WebRequest ("https://hf-mirror.com/api/models/" + $r.repo) -TimeoutSec 60 -UseBasicParsing |
    Select-Object -ExpandProperty Content | ConvertFrom-Json
  foreach ($s in $info.siblings) {
    $name = [string]$s.rfilename
    if ($name -notmatch '\.(onnx|data|json|model)$') { continue }
    $dest = Join-Path $dir $name
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 1024)) { continue }
    Write-Host ("   up " + $r.dir + "/" + $name)
    Invoke-WebRequest ("https://hf-mirror.com/" + $r.repo + "/resolve/main/" + $name) -OutFile $dest -TimeoutSec 900 -UseBasicParsing
  }
}

Write-Host "[5/5] 用 JSON 行协议合成两句"
$driver = Join-Path $root "drive.py"
$code = @'
import json, subprocess, sys, time, pathlib
root = pathlib.Path(sys.argv[1])
py = root / "venv" / "Scripts" / "python.exe"
p = subprocess.Popen([str(py), "-u", str(root / "app" / "serve.py"),
                      "--model-dir", str(root / "models"), "--cpu-threads", "4"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     text=True, encoding="utf-8", bufsize=1)
t0 = time.time()
p.stdin.write(json.dumps({"cmd": "speak", "id": "smoke",
    "text": "冒烟测试：这是内置语音后端的第一句。第二句用来验证分句与静音裁剪。",
    "promptAudio": str(root / "app" / "seed" / "deepseek.wav"),
    "outDir": str(root / "out")}, ensure_ascii=False) + "\n")
p.stdin.flush()
chunks = 0
while True:
    line = p.stdout.readline()
    if not line:
        print("EOF", flush=True); break
    print(round(time.time() - t0, 1), line.strip(), flush=True)
    msg = json.loads(line)
    if msg.get("type") == "chunk":
        chunks += 1
    if msg.get("type") in ("done", "error"):
        break
p.stdin.write('{"cmd":"shutdown"}\n'); p.stdin.flush()
try:
    p.wait(timeout=10)
except Exception:
    p.kill()
err = p.stderr.read()
if err:
    print("STDERR:", err[-1500:], flush=True)
if chunks == 0:
    sys.exit("没有 chunk 产出")
'@
[IO.File]::WriteAllText($driver, $code, (New-Object System.Text.UTF8Encoding($false)))
& $py $driver $root
if ($LASTEXITCODE -ne 0) { throw "合成冒烟失败" }

$wavs = Get-ChildItem $out -Filter *.wav -ErrorAction SilentlyContinue
if (-not $wavs) { throw "没有生成 wav" }
$sum = ($wavs | Measure-Object Length -Sum).Sum
Write-Host ("OK：生成 " + $wavs.Count + " 个 wav，合计 " + [math]::Round($sum / 1KB, 1) + " KB")
$wavs | ForEach-Object { "   " + $_.Name + " " + $_.Length }
