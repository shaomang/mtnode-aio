# 生成 probe-langs.nsh：把 electron-builder 的 assistedMessages.yml 里的 en 文案
# 转成 NSIS LangString，供 multiUserUi.nsh 里 $(chooseInstallationOptions) 这类
# 编译期引用解析。只为让探针能编译，不是产品文案。
#
# 用法：pwsh -File gen-langs.ps1   （或由 run-probe.ps1 调用）
param(
  [string]$Yml = "",
  [string]$Out = ""
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

if ($Yml -eq "") { $Yml = Join-Path $here '..\..\node_modules\app-builder-lib\templates\nsis\assistedMessages.yml' }
if ($Out -eq "") { $Out = Join-Path $here 'probe-langs.nsh' }
$Yml = (Resolve-Path -LiteralPath $Yml).Path

$lines = Get-Content -LiteralPath $Yml -Encoding UTF8
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('; 自动生成，勿手改：gen-langs.ps1 从 app-builder-lib/templates/nsis/assistedMessages.yml 取 en 文案。')
[void]$sb.AppendLine('; 用途：让 multiUserUi.nsh 里的 $(...) 字串有定义，探针才编得过。')
[void]$sb.AppendLine('')

$key = $null
$count = 0
foreach ($l in $lines) {
  if ($l -match '^([A-Za-z0-9_]+):\s*$') { $key = $Matches[1]; continue }
  if ($key -ne $null -and $l -match '^  en:\s*(.*?)\s*$') {
    $v = $Matches[1]
    # NSIS 字符串里 $ 要写成 $$，双引号写成 $\"
    $v = $v.Replace('$', '$$').Replace('"', '$' + '\"')
    [void]$sb.AppendLine('LangString ' + $key + ' 1033 "' + $v + '"')
    $key = $null
    $count++
  }
}

Set-Content -LiteralPath $Out -Value $sb.ToString() -Encoding UTF8
Write-Host ("[gen-langs] {0} 条 LangString -> {1}" -f $count, $Out)
