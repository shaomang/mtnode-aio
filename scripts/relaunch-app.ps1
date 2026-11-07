# MTNode rebuild helper: start dist\win-unpacked\MTNodeAIO.exe and prove it stayed up.
#
# Why this file exists: the rebuild script used to end with `start "" "%EXE%"` and
# nothing else. When that one shot failed (app still holding the fresh exe, a console
# that is closing in the same tick, an antivirus scan on a just-signed binary) the
# script still exited 0 and the user was left with no window at all -- the app looked
# like it simply never came back. So: start it, wait for the process to show up, wait
# a few more seconds to be sure it did not die right away, and retry with a different
# launcher before giving up.
#
# Why the first launcher is a console-less intermediate cmd (DETACHED_PROCESS + start):
# Electron/Chromium calls AttachConsole(ATTACH_PARENT_PROCESS) on startup, so an exe
# started as a plain child of this console ATTACHES to the rebuild window. The script
# then exits, but the console session stays alive because a client is still attached --
# with Windows Terminal as the default terminal host the leftover window just stays
# there with the output frozen mid-scroll (never reaching "[agent-rebuild] EXITCODE=0").
# That is exactly the "the terminal never closes after the app comes back" report.
# Measured, not assumed: a probe exe that does AttachConsole(ATTACH_PARENT_PROCESS)
# reports attached=True when started with DETACHED_PROCESS straight from this script
# (the parent is this console's Powershell, so the attach still succeeds), and
# attached=False when the launcher first creates a console-less cmd (DETACHED_PROCESS)
# which then does `start "" <exe>` -- the exe's parent has no console, so there is
# nothing to attach to. The environment block is still inherited through that cmd (so
# MTNODE_DATA_DIR and friends still reach the app), and the window still shows.
#
# Pure ASCII: it is started from a plain cmd console on an ANSI code page.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File relaunch-app.ps1 -Exe <path> [-Log <path>]
#
# Exit 0 = a new process is up and stayed up. Exit 1 = every attempt failed.

param(
  [string]$Exe = '',
  [string]$Log = '',
  [int]$Attempts = 4
)

$ErrorActionPreference = 'Continue'

function Note([string]$m) {
  Write-Host ('[agent-rebuild] ' + $m)
  if ($Log) {
    try { Add-Content -LiteralPath $Log -Value ('[agent-rebuild] ' + $m) -Encoding UTF8 } catch {}
  }
}

if (-not $Exe) { Note 'ERROR: no exe path given'; exit 1 }
if (-not (Test-Path -LiteralPath $Exe)) { Note ('ERROR: exe not found: ' + $Exe); exit 1 }

$exeDir = Split-Path -Parent $Exe
$procName = [IO.Path]::GetFileNameWithoutExtension($Exe)

function Get-RunningIds {
  return @(Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

# Console-less launcher: a detached cmd (no console at all) does `start "" <exe>`.
# The exe's parent therefore has no console, so its AttachConsole(ATTACH_PARENT_PROCESS)
# fails and this rebuild window is free to close the moment the script exits.
$detachedSrc = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MtnodeDetached
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string app, string cmdline, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    public static int StartConsoleless(string exe, string workDir)
    {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        // DETACHED_PROCESS (0x8) | CREATE_NEW_PROCESS_GROUP (0x200)
        uint flags = 0x00000008 | 0x00000200;
        string comspec = Environment.GetEnvironmentVariable("ComSpec");
        if (string.IsNullOrEmpty(comspec)) comspec = "cmd.exe";
        string cmdline = "\"" + comspec + "\" /c start \"\" \"" + exe + "\"";
        if (!CreateProcess(comspec, cmdline, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workDir, ref si, out pi))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
        int helperPid = pi.dwProcessId;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return helperPid;
    }
}
'@

$detachedReady = $false
try {
  if (-not ('MtnodeDetached' -as [type])) {
    Add-Type -TypeDefinition $detachedSrc -Language CSharp -ErrorAction Stop
  }
  $detachedReady = $true
}
catch {
  Note ('  detached launcher unavailable: ' + $_.Exception.Message)
}

$before = Get-RunningIds
$since = Get-Date

for ($try = 1; $try -le $Attempts; $try++) {
  # A fresh build may still be flushing files for a second or two: give it room.
  if ($try -gt 1) { Start-Sleep -Seconds 2 }
  Note ('launch attempt ' + $try + '/' + $Attempts + ': ' + $Exe)
  try {
    if ($try -le 2 -and $detachedReady) {
      # Normal path: console-less helper cmd, cwd = exe directory, env still inherited.
      $helper = [MtnodeDetached]::StartConsoleless($Exe, $exeDir)
      Note ('  spawned via console-less helper, pid ' + $helper)
    }
    elseif ($try -le 2) {
      # Same as a double click, but keeps the console handle: last resort only.
      Start-Process -FilePath $Exe -WorkingDirectory $exeDir -ErrorAction Stop
    }
    elseif ($try -eq 3) {
      # Second launcher: let the shell start it, no inherited console at all.
      Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Exe + '"') -ErrorAction Stop
    }
    else {
      # Last launcher: a detached cmd start.
      Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', 'start', '""', ('"' + $Exe + '"') `
        -WorkingDirectory $exeDir -WindowStyle Hidden -ErrorAction Stop
    }
  }
  catch {
    Note ('  spawn error: ' + $_.Exception.Message)
  }

  $seen = $null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $new = @(Get-RunningIds | Where-Object { $before -notcontains $_ })
    if ($new.Count -gt 0) { $seen = $new[0]; break }
  }

  if ($seen -ne $null) {
    # It appeared. Make sure it is still there a few seconds later: an exe that dies
    # during startup (locked files, bad build output) must not count as a success.
    Start-Sleep -Seconds 4
    if ((Get-RunningIds) -contains $seen) {
      Note ('OK: pid ' + $seen + ' is up')
      exit 0
    }
    Note ('pid ' + $seen + ' exited again right after start')
    $before = @(Get-RunningIds) + @($seen)
  }
  else {
    Note '  no new process appeared'
  }
}

Note 'ERROR: the app could not be started automatically'
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -MaxEvents 40 -ErrorAction Stop |
    Where-Object { $_.Message -and $_.Message.Contains($procName) } |
    Select-Object -First 5
  foreach ($e in $ev) {
    $first = ($e.Message -split "`r?`n")[0]
    Note ('  eventlog ' + $e.TimeCreated.ToString('HH:mm:ss') + ' [' + $e.LevelDisplayName + '] ' + $first)
  }
}
catch {}
exit 1
