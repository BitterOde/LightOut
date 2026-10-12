# install-night-tasks.ps1 -- register (or remove) the two unattended tasks.
#
#   DSH-Web-Supervisor   at logon, owns `dsh web` and restarts it if it exits
#   DSH-Net-Watchdog     every N minutes, repairs a lost Wi-Fi connection
#
# Both are registered for the CURRENT user. The watchdog needs administrator rights
# for its driver/service repair steps, so it is registered with -RunLevel Highest;
# that requires THIS script to run elevated (one UAC prompt, once).
#
# Task defaults that matter on a laptop (all set explicitly here):
#   * AllowStartIfOnBatteries / DontStopIfGoingOnBatteries -- Task Scheduler defaults
#     to "start only on AC power", which silently skips the task on battery.
#   * StartWhenAvailable  -- run a missed schedule as soon as possible.
#   * MultipleInstances IgnoreNew -- natural debounce, never two watchdogs at once.
#   * DO NOT set the RunOnlyIfNetworkAvailable condition: a Wi-Fi repair task gated on
#     "network is available" can never run when the network is down.
#
# Modes:
#   -Install              (default) create both tasks
#   -Uninstall            delete both tasks (and re-enable the original autostart)
#   -Status               list the tasks and their last result
#   -TakeOverAutostart    rename the Startup-folder shortcut named by -AutostartShortcut
#                         to .disabled so the supervised instance is the only one
#   -AtStartup            add a boot trigger to the supervisor (runs as SYSTEM, so DSH
#                         comes back after a reboot even before anyone logs in)
#   -WatchdogIntervalMin  repetition interval, default 2
#
# Machine-specific paths are parameters, not constants:
#   -AutostartShortcut    file name of YOUR DSH autostart shortcut in the Startup folder
#   -SupervisorLogDir     where the supervised `dsh web` output goes
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$TakeOverAutostart,
  [switch]$AtStartup,
  [int]$WatchdogIntervalMin = 2,
  [string]$AutostartShortcut = 'start-dsh-web.lnk',
  [string]$SupervisorLogDir = '',
  [switch]$Elevate
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SUP  = Join-Path $here 'dsh-web-supervisor.ps1'
$WD   = Join-Path $here 'net-watchdog.ps1'
$TASK_SUP = 'DSH-Web-Supervisor'
$TASK_WD  = 'DSH-Net-Watchdog'
$STARTUP  = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\Startup\' + $AutostartShortcut)
$STARTUP_DISABLED = "$STARTUP.disabled"
if (-not $SupervisorLogDir) { $SupervisorLogDir = Join-Path $env:LOCALAPPDATA 'DSH\logs' }

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not ($Install -or $Uninstall -or $Status)) { $Install = $true }

if (($Install -or $Uninstall) -and -not (Test-Admin)) {
  Write-Host 'This script needs an elevated PowerShell (one UAC prompt).' -ForegroundColor Yellow
  if ($Elevate) {
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    if ($Install) { $argList += '-Install' }
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($TakeOverAutostart) { $argList += '-TakeOverAutostart' }
    if ($AtStartup) { $argList += '-AtStartup' }
    $argList += @('-WatchdogIntervalMin', $WatchdogIntervalMin)
    Write-Host 'Relaunching elevated; its console output is not captured here.'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    exit 0
  }
  Write-Host 'Re-run with -Elevate to spawn the elevated copy automatically.'
  exit 1
}

function Show-Tasks {
  foreach ($n in @($TASK_SUP, $TASK_WD)) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host ("{0,-22} <not registered>" -f $n); continue }
    $i = $t | Get-ScheduledTaskInfo
    Write-Host ("{0,-22} state={1} last={2} result={3} next={4}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime)
  }
  Write-Host ''
  $supState = if (Test-Path $STARTUP) { 'present' } else { 'absent' }
  $disState = if (Test-Path $STARTUP_DISABLED) { 'disabled copy present' } else { 'no disabled copy' }
  Write-Host ("startup shortcut : {0}" -f $supState)
  Write-Host ("                   {0}" -f $disState)
}

if ($Status -and -not ($Install -or $Uninstall)) { Show-Tasks; exit 0 }

if ($Uninstall) {
  foreach ($n in @($TASK_SUP, $TASK_WD)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host ("removed task: {0}" -f $n)
    }
  }
  if ((-not (Test-Path $STARTUP)) -and (Test-Path $STARTUP_DISABLED)) {
    Move-Item -Force $STARTUP_DISABLED $STARTUP
    Write-Host 'restored the original Startup-folder shortcut'
  }
  Show-Tasks
  exit 0
}

# ------------------------------------------------------------------ install
foreach ($f in @($SUP, $WD)) {
  if (-not (Test-Path $f)) { throw "missing script: $f" }
}

if ($TakeOverAutostart) {
  if (Test-Path $STARTUP) {
    Move-Item -Force $STARTUP $STARTUP_DISABLED
    Write-Host ("Startup shortcut disabled (renamed to {0}.disabled)" -f $AutostartShortcut)
  } else {
    Write-Host 'no Startup shortcut to disable'
  }
  Write-Host 'NOTE: the DSH server that is running right now still belongs to the old window.'
  Write-Host '      Close it when convenient; the supervised instance takes over from then on.'
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# --- supervisor -------------------------------------------------------------
$supAction = New-ScheduledTaskAction -Execute $powershell `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -LogDir "{1}"' -f $SUP, $SupervisorLogDir)

$supTriggers = @(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
if ($AtStartup) { $supTriggers += (New-ScheduledTaskTrigger -AtStartup) }

$supSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$supPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
if ($AtStartup) {
  # A boot trigger cannot use an interactive token: SYSTEM is the unattended identity.
  $supPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}

Register-ScheduledTask -TaskName $TASK_SUP -Action $supAction -Trigger $supTriggers `
  -Settings $supSettings -Principal $supPrincipal -Force `
  -Description 'Keeps the DSH web server alive (restarts it if the process exits).' | Out-Null
Write-Host ("registered: {0}" -f $TASK_SUP)

# --- network watchdog -------------------------------------------------------
$wdAction = New-ScheduledTaskAction -Execute $powershell `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Once -AllowWlanSvcRestart' -f $WD)

$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMin) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$wdPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TASK_WD -Action $wdAction -Trigger $wdTrigger `
  -Settings $wdSettings -Principal $wdPrincipal -Force `
  -Description 'Probes internet reachability and repairs the WLAN link when it is lost.' | Out-Null
Write-Host ("registered: {0} (every {1} min)" -f $TASK_WD, $WatchdogIntervalMin)

Write-Host ''
Show-Tasks
Write-Host 'Verify:'
Write-Host ('  Start-ScheduledTask -TaskName {0}' -f $TASK_WD)
Write-Host ('  Get-Content "{0}" -Tail 20' -f (Join-Path $here 'net-watchdog.log'))
Write-Host ('  Get-Content "{0}" -Tail 20' -f (Join-Path $SupervisorLogDir 'dsh-web.out.log'))
Write-Host ''
Write-Host 'Remove everything with:  .\install-night-tasks.ps1 -Uninstall -Elevate'
