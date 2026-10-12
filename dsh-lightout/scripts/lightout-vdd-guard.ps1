# lightout-vdd-guard.ps1 -- resident ELEVATED guard that keeps the managed virtual
# display device DISABLED whenever no DSH host is using it.
#
# Why this exists (2026-10-09)
#   The enable-time guard (vdd-device.ps1 -ParentPid, created by the single UAC
#   elevation of a DSH session) dies together with the DSH process when Windows
#   shuts down or restarts. The "disable again" half then never runs, the device
#   stays ENABLED, and every later DSH session passes the /off pre-flight without
#   asking for elevation at all -- the "one elevation per DSH session" invariant
#   silently degrades (first observed 2026-09-30).
#   This guard lives OUTSIDE the DSH process lifetime: a scheduled task starts it
#   at logon with highest privileges (no UAC prompt), so it survives a DSH crash
#   and is back after every reboot.
#
# Invariant it maintains
#   no DSH host process running  =>  managed VDD device disabled
#
# Triggers it honours
#   1. a disable-request file (written by dsh-lightout's host half through the
#      SafelyQuit shutdown extension when the user closes DSH) -- acted on at once;
#   2. DSH host processes disappearing -- matched by pid + command-line fingerprint
#      (a bare pid is not enough: pid reuse must not look like "DSH is still here");
#   3. a low-frequency recheck while no DSH host runs (catches a device enabled by
#      hand or by a leftover process).
#
# It never ENABLES anything: enabling is the user's interactive decision and stays
# behind the /off elevation prompt. The device is idempotently disabled -- running
# this when it is already disabled is a no-op that only reports "already disabled".
#
# Actions
#   (default)  run until stopped -- the scheduled task owns the lifetime
#   -Once      one pass, then exit (self test / manual verification)
#   -DryRun    report the decisions, touch nothing
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
  # Poll interval while resident.
  [int]$PollMs = 5000,
  # Run one pass and exit (self test / manual runs).
  [switch]$Once,
  # Report decisions only: never run the disable action.
  [switch]$DryRun,
  # Disable-request file written by the dsh-lightout host half (SafelyQuit hook).
  [string]$RequestFile = '',
  # Guard state file read by the dsh-lightout /status route.
  [string]$StateFile = '',
  # Rolling log (one line per decision).
  [string]$LogFile = '',
  # The script that owns the device (single source of truth for pnputil work).
  [string]$VddScript = '',
  # Command-line fingerprint of a DSH host process (regex, matched against node.exe).
  # The trailing `web` matters: the host is launched as `node ...\dsh\lib\bin.js" web`.
  [string]$DshMatch = 'dsh\\lib\\bin\.js"?\s+web',
  # Never count DSH's own subprocess wrapper as a host. It is a node.exe whose command
  # line carries the WHOLE payload of whatever it is running -- including, as this
  # guard's own drill proved, a string that looks like the host fingerprint.
  [string]$DshExclude = 'dsh-subprocess-local',
  # Recheck the device this many polls while no DSH host runs (0 = never).
  [int]$RecheckEvery = 12,
  # Self-imposed lifetime in minutes (0 = run until stopped).
  [int]$MaxMinutes = 0
)

$ErrorActionPreference = 'Continue'

$SCRIPT_DIR = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($RequestFile -eq '') { $RequestFile = Join-Path $env:TEMP 'lightout-vdd-disable.request' }
if ($StateFile -eq '') { $StateFile = Join-Path $env:TEMP 'lightout-vdd-guard.json' }
if ($LogFile -eq '') { $LogFile = Join-Path $env:TEMP 'lightout-vdd-guard.log' }
if ($VddScript -eq '') { $VddScript = Join-Path $SCRIPT_DIR 'vdd-device.ps1' }

$MAX_LOG_LINES = 400
$KEEP_LOG_LINES = 200

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Log([string]$message) {
  $line = (Get-Date).ToString('s') + ' ' + $message
  if ($Once) { Write-Host $line }
  try {
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop
    $all = @(Get-Content -LiteralPath $LogFile -ErrorAction SilentlyContinue)
    if ($all.Count -gt $MAX_LOG_LINES) {
      Set-Content -LiteralPath $LogFile -Value ($all[-$KEEP_LOG_LINES..-1]) -Encoding UTF8
    }
  } catch { }
}

# How many DSH host processes are running. Matched on the command line, not on a pid:
# a recycled pid must never read as "DSH is still running".
function Get-DshHostCount {
  try {
    $hit = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        ($_.CommandLine -match $DshMatch) -and
        ($DshExclude -eq '' -or $_.CommandLine -notmatch $DshExclude)
      })
    return $hit.Count
  } catch {
    return -1
  }
}

# Ask the device script to disable the managed device. Idempotent; the returned
# object records what the script actually reported.
function Invoke-VddDisable([string]$reason) {
  $result = [ordered]@{ reason = $reason; at = (Get-Date).ToString('s'); ok = $false; disabled = $null; detail = '' }
  if ($DryRun) {
    $result.ok = $true
    $result.detail = 'dry-run: would run vdd-device.ps1 -Action disable'
    Write-Log ('would disable (reason=' + $reason + ') [dry-run]')
    return [pscustomobject]$result
  }
  if (-not (Test-Path -LiteralPath $VddScript)) {
    $result.detail = 'missing script: ' + $VddScript
    Write-Log ('disable FAILED (reason=' + $reason + '): ' + $result.detail)
    return [pscustomobject]$result
  }
  try {
    $out = (& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $VddScript -Action disable 2>&1 | Out-String).Trim()
    $result.detail = $out
    $m = [regex]::Match($out, 'disabled=(True|False)')
    if ($m.Success) { $result.disabled = ($m.Groups[1].Value -eq 'True') }
    $result.ok = ($result.disabled -eq $true)
    Write-Log ('disable (reason=' + $reason + ') ok=' + $result.ok + ' disabled=' + $result.disabled)
  } catch {
    $result.detail = [string]$_.Exception.Message
    Write-Log ('disable FAILED (reason=' + $reason + '): ' + $result.detail)
  }
  return [pscustomobject]$result
}

function Save-GuardState($state) {
  try {
    ([pscustomobject]$state) | ConvertTo-Json -Compress | Set-Content -LiteralPath $StateFile -Encoding UTF8
  } catch { }
}

# ------------------------------------------------------------------ main

$admin = Test-Admin
Write-Log ('guard start: admin=' + $admin + ' pollMs=' + $PollMs + ' once=' + [bool]$Once + ' dryRun=' + [bool]$DryRun + ' dshMatch=' + $DshMatch + ' dshExclude=' + $DshExclude)
if (-not $admin) {
  Write-Log 'WARNING: not elevated -- the disable action will report "needadmin" and change nothing. The scheduled task starts this with highest privileges.'
}

$previousDshHosts = -1
$polls = 0
$lastReason = ''
$lastOk = $null
$lastActionAt = ''
$deviceDisabled = $null
$started = Get-Date
$deadline = if ($MaxMinutes -gt 0) { $started.AddMinutes($MaxMinutes) } else { $null }

while ($true) {
  $polls += 1
  $dshHosts = Get-DshHostCount
  $reason = ''

  # 1. an explicit request always wins (the user is closing DSH right now)
  if (Test-Path -LiteralPath $RequestFile) {
    Remove-Item -LiteralPath $RequestFile -Force -ErrorAction SilentlyContinue
    $reason = 'request'
  }
  # 2. DSH went away (or we started with none) while the device may still be enabled
  elseif ($dshHosts -eq 0) {
    if ($previousDshHosts -gt 0) { $reason = 'dsh-gone' }
    elseif ($polls -eq 1) { $reason = 'startup' }
    elseif ($RecheckEvery -gt 0 -and ($polls % $RecheckEvery) -eq 0) { $reason = 'recheck' }
  }

  if ($reason -ne '') {
    $result = Invoke-VddDisable $reason
    $lastReason = $reason
    $lastOk = $result.ok
    $lastActionAt = $result.at
    if ($null -ne $result.disabled) { $deviceDisabled = $result.disabled }
  }

  Save-GuardState ([ordered]@{
      pid           = $PID
      admin         = $admin
      at            = (Get-Date).ToString('s')
      startedAt     = $started.ToString('s')
      polls         = $polls
      pollMs        = $PollMs
      dshHosts      = $dshHosts
      deviceDisabled = $deviceDisabled
      lastReason    = $lastReason
      lastActionAt  = $lastActionAt
      lastOk        = $lastOk
      requestFile   = $RequestFile
      stateFile     = $StateFile
      logFile       = $LogFile
      dryRun        = [bool]$DryRun
    })

  $previousDshHosts = $dshHosts

  if ($Once) { break }
  if ($null -ne $deadline -and (Get-Date) -ge $deadline) {
    Write-Log ('guard exit: MaxMinutes=' + $MaxMinutes + ' reached')
    break
  }
  Start-Sleep -Milliseconds $PollMs
}

Write-Log ('guard stop: polls=' + $polls)
