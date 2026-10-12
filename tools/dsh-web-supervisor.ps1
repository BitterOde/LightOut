# dsh-web-supervisor.ps1 -- own the DSH web server process and restart it when it dies.
#
# Why: a Startup-folder shortcut typically runs `npx ... dsh web` in a console and leaves
#      it there. If the server exits at 03:00 nobody is there to notice, so DSH stays down
#      until a human does. This script replaces that with a supervised loop.
#
# Behaviour:
#   * if something already serves 127.0.0.1:3080, exit quietly (never double-start)
#   * otherwise run `node <dsh>/lib/bin.js web --no-open`, appending output to a log
#   * when the process exits (crash, OOM, killed), wait RestartDelaySec and restart
#   * rotate the log at MaxLogMB
#
# Registered by install-night-tasks.ps1 as task "DSH-Web-Supervisor".
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

[CmdletBinding()]
param(
  [int]$Port = 3080,
  [int]$RestartDelaySec = 15,
  [string]$LogDir = '',
  [int]$MaxLogMB = 10
)

# No machine-specific default: an empty -LogDir means "%LOCALAPPDATA%\DSH\logs".
if (-not $LogDir) { $LogDir = Join-Path $env:LOCALAPPDATA 'DSH\logs' }

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$log = Join-Path $LogDir 'dsh-web.out.log'

function Write-Line([string]$msg) {
  $line = ('{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg)
  Write-Host $line
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}

function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500, $false)) { return $false }
    $client.EndConnect($iar); return $true
  } catch { return $false } finally { $client.Close() }
}

# ---------------------------------------------------------------- locate node + dsh
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Line '[fatal] node.exe not found on PATH'; exit 2 }

$globalRoot = (& npm root -g 2>$null | Select-Object -First 1)
if (-not $globalRoot) { $globalRoot = Join-Path $env:APPDATA 'npm\node_modules' }
$entry = Join-Path $globalRoot '@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $entry)) { Write-Line ("[fatal] dsh entry not found: {0}" -f $entry); exit 2 }

Write-Line ("supervisor start: node={0} entry={1} port={2}" -f $node, $entry, $Port)

if (Test-Port $Port) {
  Write-Line ("[skip] 127.0.0.1:{0} is already served by another process; nothing to do" -f $Port)
  exit 0
}

# ---------------------------------------------------------------- supervision loop
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt ($MaxLogMB * 1MB))) {
    Move-Item -Force $log "$log.1"
  }

  Write-Line 'starting dsh web (--no-open)'
  $started = Get-Date
  try {
    & $node $entry web --no-open *>> $log
    $code = $LASTEXITCODE
  } catch {
    $code = 'exception'
    Write-Line ("launch failed: {0}" -f $_.Exception.Message)
  }
  $ran = [int]((Get-Date) - $started).TotalSeconds
  Write-Line ("dsh web exited: code={0} after {1}s" -f $code, $ran)

  # A very short life usually means the port was taken or the profile is broken.
  if ($ran -lt 5 -and (Test-Port $Port)) {
    Write-Line '[stop] port is served by another process; leaving it alone'
    exit 0
  }

  Write-Line ("restarting in {0}s" -f $RestartDelaySec)
  Start-Sleep -Seconds $RestartDelaySec
}
