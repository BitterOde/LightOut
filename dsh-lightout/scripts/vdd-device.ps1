# vdd-device.ps1 -- enable / disable the virtual display device on demand.
#
# Why this exists
#   The Virtual-Display-Driver installs as a root-enumerated device (ROOT\DISPLAY\0000),
#   and Windows starts such a device at every boot. That means a virtual monitor exists
#   even when dsh-lightout is not using it -- and the driver's own README warns that a
#   GPU/chipset driver update with the device present can leave the machine on a black
#   screen. So the device is kept DISABLED by default and enabled only while it is needed.
#   The disabled flag lives in the device registry key (ConfigFlags), so it survives
#   reboots: disable it once and it stays disabled until something enables it explicitly.
#
# Actions
#   status    read-only: which VDD device this plugin manages, enabled or disabled, virtual
#             monitor present, topology summary
#   verify    read-only: device + VDD driver version + GPU driver change against the recorded
#             baseline. Needs no administrator rights, so it keeps working after UAC is
#             declined -- that is the point: you can always ask "is this machine still in a
#             state where the dark window would work?".
#   disable   (admin) disable the managed device; the virtual monitor disappears
#   enable    (admin) pre-flight, enable the device, wait for it to really come up, make sure
#             the saved layout is "internal only"; with -ParentPid it then stays resident and
#             disables the device again when that process exits (one elevation per DSH
#             session, no second prompt at the end). The watcher has NO time limit: it used
#             to disable the device after 24 hours even with the watched process alive, which
#             broke sessions that legitimately run for days (deleted 2026-10-11, see Start-Watch).
#
# Device selection (rewritten 2026-09-26)
#   This machine has TWO ROOT\DISPLAY devices: ROOT\DISPLAY\0000 (Error/disabled -- the one
#   this plugin manages) and ROOT\DISPLAY\0001 (OK/enabled). Picking "the first device whose
#   friendly name matches" therefore depended on enumeration order, and the plugin's own gate
#   could say "not available" while a usable virtual display was active. Selection is now
#   explicit: the managed instance wins; otherwise there must be exactly ONE VDD-looking
#   candidate; otherwise nothing is selected and the report names the candidates.
#   Extra instances are REPORTED, never a refusal: 0001 is enabled permanently here, so refusing
#   whenever more than one instance exists would lock the feature out for good -- and the refusal
#   would only ever be visible inside the elevated window, while /status keeps saying "disabled".
#   The dark window is judged by `activePaths>=1 && internalActive=False`, which extra virtual
#   displays do not break, so their count is simply reported as deviceCount / vddTargets.
#
# The console output is deliberately explicit: the user approves an elevation prompt for
# this script, so it must say what it does, what it does not do, and how to undo it. The
# Chinese wording lives in vdd-device.messages.zh.txt (read as UTF-8), because this file
# has to stay pure ASCII for Windows PowerShell 5.1.
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
  [ValidateSet('status', 'verify', 'enable', 'disable')]
  [string]$Action = 'status',
  # Watch this process id and disable the device again when it exits (0 = do not watch).
  [int]$ParentPid = 0,
  [int]$WaitMonitorSec = 20,
  [string]$TopologyScript = '',
  [switch]$NoWatch,
  [switch]$DryRun,
  # Re-launch this same action in an elevated window (one UAC prompt) and return at once.
  [switch]$Elevate,
  # With -Elevate: show the elevated window instead of hiding it (manual runs / debugging).
  [switch]$ShowWindow,
  # Where -Elevate records whether the UAC prompt was accepted (read back by the host half).
  [string]$ElevateLog = '',
  # verify: baseline file used to notice that a GPU/VDD driver changed since the last enable.
  [string]$Baseline = '',
  # verify: record the current versions as the new baseline (used right after a successful enable).
  [switch]$Record
)

$ErrorActionPreference = 'Stop'

$SCRIPT_DIR = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($TopologyScript -eq '') { $TopologyScript = Join-Path $SCRIPT_DIR 'lightout-topology.ps1' }
if ($ElevateLog -eq '') { $ElevateLog = Join-Path $env:TEMP 'lightout-vdd-elevate.json' }
if ($Baseline -eq '') { $Baseline = Join-Path $env:TEMP 'lightout-vdd-baseline.json' }
$MSG_FILE = Join-Path $SCRIPT_DIR 'vdd-device.messages.zh.txt'

# The instance this plugin manages, and what counts as "a virtual display" by name.
$MANAGED_VDD_ID = 'ROOT\DISPLAY\0000'
$VDD_NAME_PATTERN = 'Virtual Display|VDD|MTT'

function Test-Admin {
  try {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Show-Notes([string]$section) {
  if (-not (Test-Path $MSG_FILE)) { return }
  $on = $false
  foreach ($line in (Get-Content -LiteralPath $MSG_FILE -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    if ($line -match '^\s*\[(.+?)\]\s*$') { $on = ($Matches[1] -eq $section); continue }
    if ($on) { Write-Host $line }
  }
}

# ------------------------------------------------------------------ device selection

# Explicit device selection. Returns a selection object, never a guess:
#   choice=managed     ROOT\DISPLAY\0000 is present (the instance this plugin owns)
#   choice=named       no managed instance, but exactly one VDD-looking candidate
#   choice=ambiguous   more than one candidate and none is the managed one -> device=$null
#   choice=absent      no ROOT\DISPLAY device at all -> device=$null
function Get-VddSelection {
  $cand = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'ROOT\DISPLAY\*' })
  $managed = @($cand | Where-Object { $_.InstanceId -eq $MANAGED_VDD_ID })
  $named = @($cand | Where-Object { $_.FriendlyName -match $VDD_NAME_PATTERN })
  $device = $null
  $choice = 'absent'
  if ($managed.Count -eq 1) { $device = $managed[0]; $choice = 'managed' }
  elseif ($named.Count -eq 1) { $device = $named[0]; $choice = 'named' }
  elseif ($cand.Count -gt 0) { $choice = 'ambiguous' }
  $sib = @()
  foreach ($one in $named) {
    if ($null -eq $device -or $one.InstanceId -ne $device.InstanceId) { $sib += $one.InstanceId }
  }
  [pscustomobject]@{
    device   = $device
    choice   = $choice
    total    = $cand.Count
    vddCount = $named.Count
    siblings = ($sib -join ',')
  }
}

# The same device, re-read from the device tree (a snapshot taken before pnputil goes stale).
function Get-VddDeviceById([string]$instanceId) {
  $hit = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -eq $instanceId })
  if ($hit.Count -eq 0) { return $null }
  return $hit[0]
}

function Get-ConfigFlags([string]$instanceId) {
  $v = (Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_ConfigFlags' -ErrorAction SilentlyContinue).Data
  if ($null -eq $v) { return -1 }
  return [int]$v
}

function Get-VddMonitor {
  # Get-PnpDevice also lists devices that are no longer present (Status = 'Unknown'), so a
  # disabled VDD device would otherwise still look like "a virtual monitor is there".
  Get-PnpDevice -Class Monitor -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match 'VDD|MTT' -and $_.Status -ne 'Unknown' }
}

function Get-VddMonitorAll {
  Get-PnpDevice -Class Monitor -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'VDD|MTT' }
}

# Success means ALL THREE: the device reports OK, ConfigFlags no longer say "disabled", and a
# virtual monitor is really present. A monitor instance alone proves nothing -- with the device
# DISABLED this machine still lists one (2026-09-26: disabled=True and monitor present in the
# same report), so the old "wait for a monitor" check could pass while nothing had happened.
function Wait-VddReady([string]$instanceId, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $d = Get-VddDeviceById $instanceId
    $cf = Get-ConfigFlags $instanceId
    $m = Get-VddMonitor
    if ($null -ne $d -and $d.Status -eq 'OK' -and (($cf -band 1) -eq 0) -and $m) { return $m }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

# ------------------------------------------------------------------ topology / output helpers

function Invoke-Topology([string]$mode) {
  if (-not (Test-Path $TopologyScript)) { return '(topology script missing)' }
  # Child-process stderr must not become a terminating error: with EAP=Stop a single Write-Error
  # line from the child (exit code 0!) turns the `2>&1` redirection into a RemoteException here.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return ((& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $TopologyScript -Action $mode 2>&1 | Out-String).Trim())
  } catch {
    return ('topology ' + $mode + ' call failed: ' + [string]$_.Exception.Message)
  } finally {
    $ErrorActionPreference = $previous
  }
}

# key=<int> lookup in a script's output. $null (key absent / not a number) means "unknown" and
# must never be read as 0 -- the caller decides whether unknown is acceptable.
function Get-IntToken([string]$text, [string]$key) {
  if ($text -match ('(?:^|\s)' + [regex]::Escape($key) + '=(-?\d+)')) { return [int]$Matches[1] }
  return $null
}

function Set-DeviceState([string]$instanceId, [bool]$enable) {
  $verb = if ($enable) { '/enable-device' } else { '/disable-device' }
  $out = (& pnputil.exe $verb $instanceId 2>&1 | Out-String).Trim()
  Write-Host ('pnputil ' + $verb + ' -> ' + ($out -replace "`r?`n", ' '))
  return $out
}

# One place that knows the ConfigFlags meaning: bit 0 set = disabled. Returns $true when it
# actually had to touch the device.
function Set-DeviceEnabled($d, [bool]$want) {
  $cf = Get-ConfigFlags $d.InstanceId
  $isDisabled = (($cf -band 1) -ne 0)
  if ($isDisabled -eq (-not $want)) {
    Write-Host $(if ($want) { 'device is already enabled' } else { 'device is already disabled' })
    return $false
  }
  [void](Set-DeviceState $d.InstanceId $want)
  return $true
}

# ------------------------------------------------------------------ verification data

# One Win32_VideoController query, two derived facts (fingerprint for the baseline diff, count
# for the report). Virtual displays are excluded on purpose: the VDD driver registers one too,
# and its version is already reported separately (vddChanged) -- mixing them would hide which
# one moved.
function Get-GpuInfo {
  $adapters = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch 'Virtual Display|MttVDD' } |
    Sort-Object Name |
    ForEach-Object { ($_.Name -replace '\s+', ' ') + '@' + $_.DriverVersion })
  [pscustomobject]@{ count = $adapters.Count; fingerprint = ($adapters -join ' ; ') }
}

function Save-Baseline([string]$deviceId) {
  $version = [string](Get-PnpDeviceProperty -InstanceId $deviceId -KeyName 'DEVPKEY_Device_DriverVersion' -ErrorAction SilentlyContinue).Data
  $inf = [string](Get-PnpDeviceProperty -InstanceId $deviceId -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction SilentlyContinue).Data
  $snapshot = [ordered]@{ at = (Get-Date).ToString('s'); gpu = (Get-GpuInfo).fingerprint; driverVersion = $version; infName = $inf; device = $deviceId }
  try {
    ([pscustomobject]$snapshot) | ConvertTo-Json -Compress | Set-Content -LiteralPath $Baseline -Encoding UTF8
    Write-Host ('baseline    : recorded -> ' + $Baseline)
  } catch {
    Write-Host ('baseline    : could not be written: ' + [string]$_.Exception.Message)
  }
}

# ------------------------------------------------------------------ actions

function Show-State {
  $sel = Get-VddSelection
  $topo = Invoke-Topology 'check'
  if ($null -eq $sel.device) {
    Write-Host ('device   : NONE selected  (choice=' + $sel.choice + '  ROOT\DISPLAY candidates=' + $sel.total + '  VDD-named=' + $sel.vddCount + ')')
    if ($sel.total -gt 0) { Write-Host '           -> more than one candidate and none is the managed instance: nothing is touched' }
    Write-Host ('topology : ' + $topo)
    Write-Host ('RESULT: action=state device=none deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=unknown monitor=False admin=' + (Test-Admin) + ' topology=' + $topo)
    return
  }
  $d = $sel.device
  $cf = Get-ConfigFlags $d.InstanceId
  $disabled = (($cf -band 1) -ne 0)
  $m = Get-VddMonitor
  $monTxt = 'absent'
  if ($m) { $monTxt = 'present (' + (($m | ForEach-Object { $_.FriendlyName }) -join ', ') + ')' }
  Write-Host ('device   : ' + $d.InstanceId + '  status=' + $d.Status + '  name=' + $d.FriendlyName)
  Write-Host ('choice   : ' + $sel.choice + '  (ROOT\DISPLAY candidates=' + $sel.total + ', VDD-named=' + $sel.vddCount + ', siblings=' + $(if ($sel.siblings -eq '') { 'none' } else { $sel.siblings }) + ')')
  Write-Host ('config   : ConfigFlags=' + $cf + '  disabled=' + $disabled)
  Write-Host ('monitor  : ' + $monTxt + '   [present-only]')
  Write-Host ('known    : ' + @(Get-VddMonitorAll).Count + ' VDD monitor instance(s) in the device tree (includes non-present)')
  Write-Host ('topology : ' + $topo)
  Write-Host ('RESULT: action=state device=' + $d.InstanceId + ' deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=' + $disabled + ' monitor=' + [bool]$m + ' admin=' + (Test-Admin) + ' topology=' + $topo)
}

function Invoke-DisableCore {
  $sel = Get-VddSelection
  if ($null -eq $sel.device) {
    Write-Host ('no VDD device selected (choice=' + $sel.choice + ', candidates=' + $sel.total + ') -- nothing to disable')
    Write-Host ('RESULT: action=disable ok=true changed=false device=none deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=unknown monitor=False')
    return
  }
  $d = $sel.device
  $changed = Set-DeviceEnabled $d $false
  Start-Sleep -Seconds 2
  $m = Get-VddMonitor
  $cfgNow = Get-ConfigFlags $d.InstanceId
  $disabledNow = (($cfgNow -band 1) -ne 0)
  Write-Host ('virtual monitor now: ' + $(if ($m) { 'STILL PRESENT' } else { 'absent' }) + ' (present-only check)')
  Write-Host ('topology: ' + (Invoke-Topology 'check'))
  Write-Host ('RESULT: action=disable ok=' + $disabledNow + ' changed=' + $changed + ' device=' + $d.InstanceId + ' deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=' + $disabledNow + ' monitor=' + [bool]$m)
}

function Invoke-EnableCore {
  $sel = Get-VddSelection
  if ($null -eq $sel.device) {
    # The ONLY refusal left: no unambiguous device to talk to (the managed instance is gone and
    # the candidates cannot be told apart). Refusing merely because several instances EXIST would
    # lock the feature out for good on this machine -- 0001 is enabled permanently.
    Write-Host ('no single VDD device to enable: choice=' + $sel.choice + ', ROOT\DISPLAY candidates=' + $sel.total)
    if ($sel.total -gt 0) { Write-Host '  -> several candidates and none is the managed instance: nothing is touched' }
    Write-Host ('RESULT: action=enable ok=false reason=' + $(if ($sel.total -eq 0) { 'no-device' } else { 'ambiguous-vdd-device' }) + ' device=none deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total)
    return $false
  }
  $d = $sel.device

  # Extra instances / extra targets are REPORTED, never a refusal -- see the header note. The dark
  # window is judged afterwards by `activePaths>=1 && internalActive=False`, which a second
  # virtual display does not break, so the counts are simply carried into the RESULT line.
  $topo = Invoke-Topology 'check'
  $vddTargets = Get-IntToken $topo 'vddTargets'
  $vddTargetsTxt = $(if ($null -eq $vddTargets) { 'unknown' } else { [string]$vddTargets })
  if ($sel.vddCount -gt 1) {
    Write-Host ('note     : ' + $sel.vddCount + ' VDD-looking device instance(s) present (other: ' + $(if ($sel.siblings -eq '') { 'none' } else { $sel.siblings }) + '); only the managed one is touched')
  }
  if ($null -ne $vddTargets -and $vddTargets -gt 1) {
    Write-Host ('note     : ' + $vddTargets + ' virtual display target(s) available; the dark window only needs activePaths>=1 and internalActive=False')
  }

  [void](Set-DeviceEnabled $d $true)
  $m = Wait-VddReady $d.InstanceId $WaitMonitorSec
  if (-not $m) {
    Write-Host ('ERROR: the device did not come up (status + ConfigFlags + monitor) within ' + $WaitMonitorSec + 's -- disabling it again')
    [void](Set-DeviceEnabled $d $false)
    Write-Host ('RESULT: action=enable ok=false reason=no-monitor device=' + $d.InstanceId + ' deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' vddTargets=' + $vddTargetsTxt)
    return $false
  }
  Write-Host ('virtual monitor present: ' + (($m | ForEach-Object { $_.FriendlyName }) -join ', '))
  Write-Host 'making sure the saved layout is "internal panel only" (so day-to-day use is unchanged)'
  $normalizeOut = Invoke-Topology 'normalize'
  Write-Host ($normalizeOut -replace "`r?`n", ' | ')
  # The normalize step is reported, not assumed: if it was refused (external monitor present) the
  # saved layout is simply unchanged, which is the safe outcome -- say so instead of implying it.
  if ($normalizeOut -notmatch 'apply=0') { Write-Host 'note        : normalize did NOT report apply=0 -- the saved layout is unchanged' }
  # Known-good fingerprint: -Action verify compares against this later, so a GPU/VDD driver
  # update that happens after this point is visible before the next dark window.
  Save-Baseline $d.InstanceId
  Write-Host ('RESULT: action=enable ok=true device=' + $d.InstanceId + ' deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' monitor=true vddTargets=' + $vddTargetsTxt)
  return $true
}

# ------------------------------------------------------------------ verify

function Invoke-Verify {
  Show-Notes 'verify'
  $sel = Get-VddSelection
  $gpu = Get-GpuInfo
  if ($null -eq $sel.device) {
    Write-Host ('device      : NONE selected (choice=' + $sel.choice + ', ROOT\DISPLAY candidates=' + $sel.total + ')')
    Write-Host ('RESULT: action=verify ok=true device=none deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=unknown verdict=missing driverVersion= infName= driverStore=False monitor=0 gpuCount=' + $gpu.count + ' gpuChanged=False vddChanged=False')
    return
  }

  $d = $sel.device
  $cf = Get-ConfigFlags $d.InstanceId
  $disabled = (($cf -band 1) -ne 0)
  $driverVersion = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverVersion' -ErrorAction SilentlyContinue).Data
  $infName = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction SilentlyContinue).Data
  $driverDate = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_DriverDate' -ErrorAction SilentlyContinue).Data
  $storePresent = $false
  if ($infName -ne '') { $storePresent = (Test-Path (Join-Path $env:WINDIR ('INF\' + $infName))) }
  $monitors = @(Get-VddMonitor).Count

  $previous = $null
  if (Test-Path $Baseline) {
    try { $previous = Get-Content -LiteralPath $Baseline -Raw | ConvertFrom-Json } catch { $previous = $null }
  }
  $gpuChanged = ($null -ne $previous -and [string]$previous.gpu -ne '' -and [string]$previous.gpu -ne $gpu.fingerprint)
  $vddChanged = ($null -ne $previous -and [string]$previous.driverVersion -ne '' -and [string]$previous.driverVersion -ne $driverVersion)

  $verdict = 'ready'
  if ($disabled) { $verdict = 'disabled' }
  if (-not $storePresent) { $verdict = 'driver-missing' }

  Write-Host ('device      : ' + $d.InstanceId + '  status=' + $d.Status + '  disabled=' + $disabled)
  Write-Host ('choice      : ' + $sel.choice + '  (ROOT\DISPLAY candidates=' + $sel.total + ', VDD-named=' + $sel.vddCount + ', siblings=' + $(if ($sel.siblings -eq '') { 'none' } else { $sel.siblings }) + ')')
  Write-Host ('vdd driver  : ' + $driverVersion + '  inf=' + $infName + '  date=' + $driverDate + '  driverStore=' + $storePresent)
  Write-Host ('gpu adapters: ' + $gpu.fingerprint)
  Write-Host ('monitors    : ' + $monitors)
  if ($null -eq $previous) {
    Write-Host 'baseline    : (none yet -- it is recorded the first time the device is enabled)'
  } else {
    Write-Host ('baseline    : recorded=' + [string]$previous.at + '  gpuChanged=' + $gpuChanged + '  vddChanged=' + $vddChanged)
    if ($gpuChanged) {
      Write-Host 'WARNING: the GPU/display driver changed since the device was last enabled.'
      Write-Host '         Check that the panel comes back before relying on this for an unattended run.'
    }
    if ($vddChanged) {
      Write-Host 'WARNING: the virtual display driver version changed since the last enable.'
    }
  }
  if (-not $storePresent) {
    Write-Host 'WARNING: the INF backing the device is gone from the DriverStore; reinstall the VDD driver.'
  }

  if ($Record) {
    Save-Baseline $d.InstanceId
  }

  Write-Host ('RESULT: action=verify ok=true device=' + $d.InstanceId + ' deviceChoice=' + $sel.choice + ' deviceCount=' + $sel.total + ' disabled=' + $disabled + ' driverVersion=' + $driverVersion + ' infName=' + $infName + ' driverStore=' + $storePresent + ' monitor=' + $monitors + ' gpuCount=' + $gpu.count + ' gpuChanged=' + $gpuChanged + ' vddChanged=' + $vddChanged + ' verdict=' + $verdict)
}

# ------------------------------------------------------------------ resident watch

function Start-Watch([int]$parentPid) {
  # The watcher disables the device when the process it was started for goes away -- and ONLY
  # then. A 24 hour cap (-MaxWatchMinutes, default 1440) used to sit on top of that and disable
  # the device even with the watched process still alive; it was deleted 2026-10-11 (user
  # ruling) because a DSH session that legitimately runs for days had its virtual display
  # pulled out from under it -- mid-dark-window, and it cost the user another UAC prompt per
  # 24 h because an enabled device is what makes /off skip the elevation.
  # What the cap was really protecting against was pid reuse: with a bare `Get-Process -Id`
  # check the watcher can see an unrelated process that inherited the pid and conclude that
  # DSH is still alive -- forever. That job now belongs to the start time: same pid with a
  # different start time is a different process, so it counts as "the watched session is gone".
  $target = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
  $watchedStart = $null
  if ($null -ne $target) {
    try { $watchedStart = $target.StartTime } catch { $watchedStart = $null }
  }
  Write-Host ''
  Write-Host ('watching process ' + $parentPid + ': the device will be disabled again when it exits')
  Write-Host '(no time limit; disable it by hand any time with -Action disable)'
  $reason = 'parent-gone'
  while ($true) {
    $now = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
    if ($null -eq $now) { $reason = 'parent-gone'; break }
    if ($null -ne $watchedStart) {
      $nowStart = $null
      try { $nowStart = $now.StartTime } catch { $nowStart = $null }
      if ($null -ne $nowStart -and $nowStart -ne $watchedStart) { $reason = 'pid-reused'; break }
    }
    Start-Sleep -Seconds 5
  }
  # "the process died" and "the pid was recycled" both mean the session we were watching is
  # gone, and both end with the device disabled (the safe default for it) -- but the reason has
  # to stay readable, because the two are diagnosed differently.
  if ($reason -eq 'parent-gone') {
    Write-Host ('process ' + $parentPid + ' is gone -- disabling the virtual display device again')
  } else {
    Write-Host ('pid ' + $parentPid + ' now belongs to another process -- disabling the virtual display device again')
  }
  Invoke-DisableCore
  Write-Host ('watch: reason=' + $reason)
}

# ------------------------------------------------------------------ main

Write-Host ''
Write-Host '=== dsh-lightout :: virtual display device (VDD) ==='
Write-Host ('action=' + $Action + '  admin=' + (Test-Admin) + '  dryRun=' + $DryRun.IsPresent + '  when=' + (Get-Date).ToString('s'))
Write-Host ''

# status/verify are read-only and never need rights; enable/disable do.
$needsAdmin = ($Action -ne 'status' -and $Action -ne 'verify')
if ($needsAdmin -and (-not (Test-Admin)) -and $Elevate) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Action', $Action)
  if ($ParentPid -gt 0) { $argList += @('-ParentPid', $ParentPid) }
  if ($NoWatch) { $argList += '-NoWatch' }
  if ($DryRun) { $argList += '-DryRun' }
  $argList += @('-ElevateLog', ('"' + $ElevateLog + '"'), '-Baseline', ('"' + $Baseline + '"'))
  Write-Host 'Asking Windows for administrator rights -- you will get exactly one UAC prompt.'
  Write-Host 'The elevated window is HIDDEN by default: the enable action doubles as the resident'
  Write-Host 'guard that disables the device again when DSH exits, and a window nobody can click'
  Write-Host 'cannot be closed by accident (that is how the first selftest lost its guard).'
  Write-Host 'Pass -ShowWindow to watch it instead; the Chinese explanation is printed there.'
  # Record the UAC outcome. If the user says No, Start-Process throws "The operation was
  # canceled by the user" -- writing that down lets the host half report "authorization
  # declined" immediately instead of letting the UI wait out a timeout.
  $declined = $false
  $failure = ''
  try {
    if ($ShowWindow) {
      Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Normal -ArgumentList $argList | Out-Null
    } else {
      Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argList | Out-Null
    }
  } catch {
    $declined = $true
    $failure = [string]$_.Exception.Message
  }
  $elevationRecord = [ordered]@{
    action    = $Action
    launched  = (-not $declined)
    declined  = $declined
    at        = (Get-Date).ToString('s')
    parentPid = $ParentPid
    error     = $failure
  }
  try { ([pscustomobject]$elevationRecord) | ConvertTo-Json -Compress | Set-Content -LiteralPath $ElevateLog -Encoding UTF8 } catch { }
  Write-Host ('RESULT: action=elevate launched=' + (-not $declined) + ' declined=' + $declined + ' target=' + $Action + ' parentPid=' + $ParentPid + ' window=' + $(if ($ShowWindow) { 'shown' } else { 'hidden' }))
  exit 0
}

# The same three steps used to be copy-pasted before every privileged action:
# refuse without admin, print the Chinese explanation, then honour -DryRun.
function Assert-Admin([string]$section) {
  if (-not (Test-Admin)) {
    Show-Notes 'needadmin'
    Write-Host ('RESULT: action=' + $section + ' ok=false reason=not-admin')
    exit 2
  }
  Show-Notes $section
  if ($DryRun) { Write-Host ('[dry-run] would run ' + $section); Show-State; exit 0 }
}

switch ($Action) {

  'status' {
    Show-Notes 'status'
    Show-State
  }

  'verify' {
    Invoke-Verify
  }

  'disable' {
    Assert-Admin 'disable'
    Invoke-DisableCore
  }

  'enable' {
    Assert-Admin 'enable'
    $ok = Invoke-EnableCore
    if (-not $ok) { exit 4 }
    if ($ParentPid -gt 0 -and -not $NoWatch) { Start-Watch $ParentPid }
  }
}
