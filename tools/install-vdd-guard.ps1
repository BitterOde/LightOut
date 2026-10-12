# install-vdd-guard.ps1 -- register (or remove) the resident VDD guard task.
#
#   DSH-LightOut-VDD-Guard   at logon, RunLevel Highest, NO UAC prompt:
#     keeps the managed virtual display device (ROOT\DISPLAY\0000) disabled
#     whenever no DSH host process is running.
#
# Why a scheduled task and not the plugin itself
#   * disabling the device needs administrator rights;
#   * the enable-time guard created by the /off elevation dies together with the DSH
#     process when Windows shuts down or restarts, so the "disable again" half never
#     runs and later DSH sessions are never asked to elevate at all;
#   * a task started at logon with RunLevel Highest hands the guard those rights
#     without a UAC prompt, and it is back after every reboot.
#
# The guard never ENABLES anything: enabling stays the user's interactive decision
# behind the /off elevation prompt. One elevation per DSH session is preserved.
#
# Modes
#   -Install    (default) create/replace the task and start it now; it doubles as an
#               update: a guard that is already running is stopped first, because the
#               task's MultipleInstances=IgnoreNew would otherwise keep the OLD process
#               (running the OLD script) and Start-ScheduledTask would silently do nothing
#   -Restart    stop the running guard and start it again from the task -- this is how a
#               CHANGED guard script takes effect (PowerShell reads a -File script once,
#               at process start, so an edit never reaches a live process)
#   -Uninstall  stop and delete the task, kill the running guard
#   -Status     task state + running guard + last guard state file + whether the running
#               guard is older than the script on disk
#   -Elevate    relaunch this script elevated (one UAC prompt) when needed
#
# What does NOT need any of this
#   dsh-lightout\scripts\vdd-device.ps1 (the pnputil half) is spawned fresh on every guard
#   pass, so editing it is picked up by the next pass without touching the guard process.
#   The plugin's host half (lib/index.js, the SafelyQuit hook) needs a `dsh web` restart
#   instead -- unrelated to this task.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Restart,
  [switch]$Status,
  [switch]$Elevate
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$GUARD = Join-Path $repoRoot 'dsh-lightout\scripts\lightout-vdd-guard.ps1'
$TASK = 'DSH-LightOut-VDD-Guard'
$REQUEST_FILE = Join-Path $env:TEMP 'lightout-vdd-disable.request'
$STATE_FILE = Join-Path $env:TEMP 'lightout-vdd-guard.json'

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not ($Install -or $Uninstall -or $Restart -or $Status)) { $Install = $true }

if (($Install -or $Uninstall -or $Restart) -and -not (Test-Admin)) {
  Write-Host 'This script needs an elevated PowerShell (one UAC prompt).' -ForegroundColor Yellow
  if ($Elevate) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Install) { $argList += '-Install' }
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($Restart) { $argList += '-Restart' }
    Write-Host 'Relaunching elevated; its console output is not captured here.'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    exit 0
  }
  Write-Host 'Re-run with -Elevate to spawn the elevated copy automatically.'
  exit 1
}

# Finding the guard process. Two sources, because ONE is not enough:
#   * the pid recorded in the guard's own state file -- a NON-elevated shell cannot read
#     the CommandLine of an ELEVATED process (WMI returns null), so a command-line-only
#     matcher silently reported "not running" while the guard was alive and polling, and
#     Stop-Guard therefore never stopped it (an update would look applied but was not);
#   * the command line, when it IS readable, as a second opinion (and for a guard started
#     by hand rather than by the task).
# Every entry carries `Via` so the report says where the answer came from.
# The `\.ps1` tail still matters: a bare 'lightout-vdd-guard' also matches the command line
# of the very shell doing the looking.
function Get-GuardProcesses {
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath $STATE_FILE) {
    try {
      $state = Get-Content -LiteralPath $STATE_FILE -Raw | ConvertFrom-Json
      $wantPid = [int]$state.pid
      if ($wantPid -gt 0) {
        $proc = Get-Process -Id $wantPid -ErrorAction SilentlyContinue
        if ($proc -and ($proc.ProcessName -match 'powershell')) {
          $seen[$wantPid] = $true
          [void]$out.Add([pscustomobject]@{ ProcessId = $wantPid; CreationDate = $proc.StartTime; Via = 'state-file pid' })
        }
      }
    } catch { }
  }
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
    $pid2 = [int]$c.ProcessId
    if ($seen[$pid2]) { continue }
    if ($c.CommandLine -and ($c.CommandLine -match 'lightout-vdd-guard\.ps1')) {
      $seen[$pid2] = $true
      [void]$out.Add([pscustomobject]@{ ProcessId = $pid2; CreationDate = $c.CreationDate; Via = 'command line' })
    }
  }
  return $out.ToArray()
}

# Stop every running guard process; returns how many were stopped.
function Stop-Guard {
  $stopped = 0
  foreach ($p in Get-GuardProcesses) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host ("stopped guard pid {0}" -f $p.ProcessId)
      $stopped += 1
    } catch { }
  }
  return $stopped
}

function Show-Status {
  $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
  if (-not $t) {
    Write-Host ("{0,-26} <not registered>" -f $TASK)
  } else {
    $i = $t | Get-ScheduledTaskInfo
    Write-Host ("{0,-26} state={1} last={2} result={3} next={4}" -f $TASK, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime)
  }
  $procs = Get-GuardProcesses
  if ($procs.Count -eq 0) {
    Write-Host ("{0,-26} <not running>" -f 'guard process')
  } else {
    $first = $procs | Sort-Object CreationDate | Select-Object -First 1
    $started = $first.CreationDate
    Write-Host ("{0,-26} pid={1} started={2}  [found via {3}]" -f 'guard process', ($procs.ProcessId -join ','), $started, $first.Via)
    # PowerShell reads a -File script once, at process start: a script newer than the
    # process means the running guard still executes the OLD code.
    if (Test-Path -LiteralPath $GUARD) {
      $scriptAt = (Get-Item -LiteralPath $GUARD).LastWriteTime
      if ($started -lt $scriptAt) {
        Write-Host ("{0,-26} script ({1}) is NEWER than the guard -- run -Restart to pick it up" -f 'guard freshness', $scriptAt)
      } else {
        Write-Host ("{0,-26} up to date (the guard started after the script was written)" -f 'guard freshness')
      }
    }
  }
  if (Test-Path -LiteralPath $STATE_FILE) {
    Write-Host 'guard state:'
    Get-Content -LiteralPath $STATE_FILE -Raw | Write-Host
  } else {
    Write-Host ("guard state       : <no state file at {0}>" -f $STATE_FILE)
  }
}

if ($Status -and -not ($Install -or $Uninstall -or $Restart)) { Show-Status; exit 0 }

if ($Uninstall) {
  [void](Stop-Guard)
  if (Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TASK -Confirm:$false
    Write-Host ("removed task: {0}" -f $TASK)
  }
  Remove-Item -LiteralPath $REQUEST_FILE -Force -ErrorAction SilentlyContinue
  Write-Host 'the device itself is untouched (the guard only ever disables it)'
  Show-Status
  exit 0
}

# ------------------------------------------------------------------ restart

# How a CHANGED guard script takes effect: kill the live process and let the task start a
# fresh one (a running PowerShell never re-reads its -File script).
if ($Restart) {
  if (-not (Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue)) {
    Write-Host ("{0} is not registered yet -- run -Install first" -f $TASK)
    exit 1
  }
  [void](Stop-Guard)
  Start-ScheduledTask -TaskName $TASK
  Start-Sleep -Seconds 3
  Write-Host 'guard restarted (the new process re-reads the script from disk)'
  Write-Host ''
  Show-Status
  exit 0
}

# ------------------------------------------------------------------ install

if (-not (Test-Path -LiteralPath $GUARD)) { throw "missing guard script: $GUARD" }

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$action = New-ScheduledTaskAction -Execute $powershell `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $GUARD)

# At logon (this user) is enough: the guard only has work to do once somebody can
# actually press the dark-window button.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# RunLevel Highest on an interactive user token: the guard needs administrator
# rights for pnputil, and a task does not raise a UAC prompt for that.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description 'dsh-lightout: keeps the managed virtual display device disabled whenever no DSH host is running.' | Out-Null
Write-Host ("registered: {0}" -f $TASK)

# Stop a guard that is already running BEFORE starting the task: with
# MultipleInstances=IgnoreNew the task keeps the OLD process (running the OLD script) and
# Start-ScheduledTask would silently do nothing -- which is exactly how an update used to
# look like it had been applied while the old code kept running.
[void](Stop-Guard)
Start-ScheduledTask -TaskName $TASK
Start-Sleep -Seconds 3
Write-Host 'started now (the next guard pass runs immediately; the state file lands within a few seconds)'
Write-Host ''
Show-Status
Write-Host ''
Write-Host 'Verify later with:'
Write-Host ('  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -Status' -f $PSCommandPath)
Write-Host ('  Get-Content "{0}" -Tail 20' -f (Join-Path $env:TEMP 'lightout-vdd-guard.log'))
Write-Host ''
Write-Host ('Remove everything with:  "{0}" -Uninstall -Elevate' -f $PSCommandPath)
