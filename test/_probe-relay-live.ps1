# 只读探针（非交付件）：判断本机 auth-store.json 的 payload 到底是哪种加密，
# 并（解得出时）用它实测中转站接口，看服务端到底回什么。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\_probe-relay-live.ps1
# 不打印明文 token（只打印打码串）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$j = Get-Content "$env:APPDATA\pipeline-console\auth-store.json" -Raw | ConvertFrom-Json
$b = [Convert]::FromBase64String($j.payload)
"payload: enc=$($j.enc) bytes=$($b.Length) 前缀=" + [Text.Encoding]::ASCII.GetString($b[0..2])

$plain = $null
try {
  $d = [System.Security.Cryptography.ProtectedData]::Unprotect($b[3..($b.Length - 1)], $null, 'CurrentUser')
  $plain = [Text.Encoding]::UTF8.GetString($d); "分支1（DPAPI，跳过 v10 前缀）成功"
} catch { "分支1 失败：" + $_.Exception.Message }
if (-not $plain) {
  try {
    $d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
    $plain = [Text.Encoding]::UTF8.GetString($d); "分支2（DPAPI，整串）成功"
  } catch { "分支2 失败：" + $_.Exception.Message }
}
if (-not $plain) { "两种 DPAPI 解不开 ⇒ payload 是 AES-GCM（需要 Chromium 主密钥，见 node 探针）"; exit 0 }

$o = $plain | ConvertFrom-Json
$tk = [string]$o.token
$mask = if ($tk.Length -le 7) { '*' * $tk.Length } else { $tk.Substring(0, 4) + '****' + $tk.Substring($tk.Length - 4) }
"解密成功：user=$($o.user.username) token=$mask len=$($tk.Length)"

$cfg = Get-Content "$env:APPDATA\pipeline-console\pipeline-console\config.json" -Raw | ConvertFrom-Json
$rp = $cfg.providers | Where-Object { $_.source -eq 'mtnode-relay' } | Select-Object -First 1
$base = ([string]$rp.baseUrl).TrimEnd('/')
"relay baseUrl=$base"

$H = @{ Authorization = "Bearer $tk" }
function Show([string]$label, [string]$url, $body) {
  try {
    if ($body) {
      $r = Invoke-WebRequest -Uri $url -Headers $H -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing
    } else {
      $r = Invoke-WebRequest -Uri $url -Headers $H -UseBasicParsing
    }
    "[$label] HTTP $($r.StatusCode)"; $r.Content.Substring(0, [Math]::Min(600, $r.Content.Length))
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $sr = New-Object IO.StreamReader($resp.GetResponseStream())
      "[$label] HTTP $([int]$resp.StatusCode)"; $sr.ReadToEnd().Substring(0, [Math]::Min(600, 600))
    } else { "[$label] 失败：" + $_.Exception.Message }
  }
}
Show 'relay me' (($base -replace '/relay/v1$', '') + '/api/relay/me') $null
Show 'relay chat deepseek-v4-flash' ($base + '/chat/completions') '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":3}'
