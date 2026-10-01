# 只读探针（非交付件）：解出 Chromium os_crypt 主密钥（DPAPI，当前用户），只输出 base64。
# 用法（必须用 Windows PowerShell 5.1，pwsh 7 没有 System.Security.Cryptography.ProtectedData）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\_probe-dpapi-masterkey.ps1
Add-Type -AssemblyName System.Security
$ls = Get-Content "$env:APPDATA\pipeline-console\Local State" -Raw | ConvertFrom-Json
$b = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length - 1)], $null, 'CurrentUser')
'KEYB64=' + [Convert]::ToBase64String($d)
