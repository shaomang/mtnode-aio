# 只读探针（非交付件）：把 %APPDATA% 下所有 profile 的 os_crypt 主密钥都解出来（排除 Temp），
# 供 node 逐个试解 auth-store.json（配合 test\_probe-decrypt-allkeys.js）。用法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\_probe-keys-broad.ps1
# ⚠️ 它写的 test\_probe-keys.json 是本机主密钥材料：**只在本机复核用，用完立即删除，绝不提交入库**。
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Security

$cands = Get-ChildItem "$env:APPDATA" -Recurse -Depth 3 -Filter 'Local State' -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 0 -and $_.FullName -notmatch '\\Temp\\' }
$out = @()
foreach ($f in $cands) {
  $rec = [ordered]@{ file = $f.FullName; mtime = $f.LastWriteTime.ToString('s'); key = $null; err = $null }
  try {
    $ls = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $ek = $ls.os_crypt.encrypted_key
    if ($ek) {
      $b = [Convert]::FromBase64String($ek)
      $d = [System.Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length - 1)], $null, 'CurrentUser')
      $rec.key = [Convert]::ToBase64String($d)
    } else { $rec.err = 'no encrypted_key' }
  } catch { $rec.err = $_.Exception.Message }
  $out += $rec
}
Set-Content -Path (Join-Path $PSScriptRoot '_probe-keys.json') -Value ($out | ConvertTo-Json -Depth 4) -Encoding UTF8
"共 " + $out.Count + " 个 profile，成功解出 " + ($out | Where-Object { $_.key }).Count + " 把主密钥"
