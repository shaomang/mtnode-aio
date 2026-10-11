# MTNode - visible console window probe (read-only, zero dependency)
#
# Prints every VISIBLE console window on this desktop, in both host flavours:
#   ConsoleWindowClass           - classic conhost console
#   CASCADIA_HOSTING_WINDOW_CLASS - Windows Terminal window (default terminal host on Win11)
#   PseudoConsoleWindow          - the pseudo console window a Windows Terminal window hosts
#
# Why this exists: a console-subsystem child process that has no console to inherit (its parent was
# started as pythonw / CREATE_NO_WINDOW + DETACHED_PROCESS) makes Windows allocate a BRAND NEW visible
# terminal window. That is exactly how the (now removed) GPT-SoVITS training run produced "hundreds of
# windows" (ffmpeg-python Popen per audio file, DataLoader with 5..12 workers); the remaining local
# backends (Breeze / ComfyUI / llama / SenseNova) can still spawn such children, so the mechanism and
# this ruler stay. test/smoke-console-silent.js reuses this very script as the
# ruler for its "no new console window" assertion, so keep the JSON contract stable.
#
# Manual use:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-console-windows.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-console-windows.ps1 -WatchSeconds 8 -IntervalMs 150 -Pretty
#
# Output (stdout, single JSON object):
#   { ok, mode: "snapshot"|"watch", seconds, peak, distinct, items: [{ cls, handle, pid }] }
#   peak     = largest number of such windows seen at the same moment
#   distinct = union of window handles over the whole observation window
param(
  [int]$WatchSeconds = 0,
  [int]$IntervalMs = 200,
  [switch]$Pretty
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class MtnodeConsoleWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  static bool IsConsoleClass(string c) {
    return c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS" || c == "PseudoConsoleWindow";
  }

  public static List<string> Snapshot() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      string cls = sb.ToString();
      if (!IsConsoleClass(cls)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(cls + "|" + h.ToInt64() + "|" + pid);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$peak = 0
if ($WatchSeconds -gt 0) {
  $deadline = (Get-Date).AddSeconds($WatchSeconds)
  while ((Get-Date) -lt $deadline) {
    $cur = [MtnodeConsoleWindows]::Snapshot()
    if ($cur.Count -gt $peak) { $peak = $cur.Count }
    foreach ($x in $cur) { [void]$seen.Add($x) }
    Start-Sleep -Milliseconds ([Math]::Max(50, $IntervalMs))
  }
} else {
  foreach ($x in [MtnodeConsoleWindows]::Snapshot()) { [void]$seen.Add($x) }
  $peak = $seen.Count
}

$items = @()
foreach ($x in $seen) {
  $parts = $x.Split('|')
  $items += [pscustomobject]@{ cls = $parts[0]; handle = [int64]$parts[1]; pid = [int]$parts[2] }
}
$out = [pscustomobject]@{
  ok       = $true
  mode     = $(if ($WatchSeconds -gt 0) { 'watch' } else { 'snapshot' })
  seconds  = $WatchSeconds
  peak     = $peak
  distinct = $items.Count
  items    = $items
}
if ($Pretty) { $out | ConvertTo-Json -Depth 4 } else { $out | ConvertTo-Json -Depth 4 -Compress }
