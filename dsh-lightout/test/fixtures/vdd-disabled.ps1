# vdd-disabled.ps1 -- offline stub for vdd-device.ps1 with the device DISABLED (the default).
#
# Also plays "the user clicked No on the UAC prompt": when the host half asks for an elevation
# (-Action enable -Elevate -ElevateLog <path>), it writes the same declined record the real
# script writes when Start-Process -Verb RunAs throws "canceled by the user". That is what lets
# test/host.test.mjs prove the declined path end to end.
#
# ASCII-only (PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

param(
  [ValidateSet('status', 'verify', 'enable', 'disable', 'selftest')]
  [string]$Action = 'status',
  [int]$ParentPid = 0,
  [int]$WaitMonitorSec = 20,
  [string]$TopologyScript = '',
  [switch]$NoWatch,
  [switch]$DryRun,
  [switch]$Elevate,
  [switch]$ShowWindow,
  [string]$ElevateLog = '',
  [string]$Baseline = '',
  [switch]$Record
)

if ($env:LIGHTOUT_TEST_MARKER) {
  $line = 'vdd:' + $Action
  if ($Elevate) { $line = $line + ':elevate' }
  if ($ParentPid -gt 0) { $line = $line + ':parent=' + $ParentPid }
  Add-Content -LiteralPath $env:LIGHTOUT_TEST_MARKER -Value $line -Encoding UTF8
}

$common = 'device=ROOT\DISPLAY\0000 disabled=True monitor=1 driverStore=True deviceChoice=managed deviceCount=2'

# /vdd dedup wants BOTH directions: alive launcher => dedup, exited launcher => a new request.
# Only the ELEVATE path lingers (verify must stay fast: the host runs it on every /status).
# ASCII only: a non-ASCII comment in a BOM-less .ps1 makes PowerShell 5.1 mis-tokenize the NEXT
# line (it silently swallowed this very statement once).
if ($Elevate -and $env:LIGHTOUT_TEST_VDD_HOLD_MS) { Start-Sleep -Milliseconds ([int]$env:LIGHTOUT_TEST_VDD_HOLD_MS) }

if ($Action -eq 'status') {
  Write-Output 'device   : ROOT\DISPLAY\0000  status=Error  name=Virtual Display Driver (stub)'
  Write-Output 'config   : ConfigFlags=1  disabled=True'
  Write-Output 'monitor  : present (Generic Monitor (VDD by MTT))   [present-only]'
  Write-Output 'topology : activePaths=1 internalActive=True vddActive=False'
  Write-Output ('RESULT: action=state ' + $common + ' admin=True topology=activePaths=1 internalActive=True vddActive=False')
} elseif ($Action -eq 'verify') {
  Write-Output 'device      : ROOT\DISPLAY\0000  status=Error  disabled=True'
  Write-Output 'vdd driver  : 1.2.3.4  inf=oem88.inf  driverStore=True'
  Write-Output 'baseline    : (none yet -- it is recorded the first time the device is enabled)'
  Write-Output ('RESULT: action=verify ok=true ' + $common + ' driverVersion=1.2.3.4 infName=oem88.inf gpuCount=1 gpuChanged=False vddChanged=False verdict=disabled topology=activePaths=1 internalActive=True vddActive=False')
} elseif ($Elevate) {
  # Stands in for "the user declined the UAC prompt".
  if ($ElevateLog -ne '') {
    # NOTE: do not name this $record -- PowerShell is case-insensitive and the script has a
    # -Record switch parameter, so the assignment would try to write an OrderedDictionary into
    # a SwitchParameter and throw (that is exactly how the real script was broken).
    $payload = [ordered]@{ action = $Action; launched = $false; declined = $true; at = (Get-Date).ToString('s'); parentPid = $ParentPid; error = 'the operation was canceled by the user (stub)' }
    ([pscustomobject]$payload) | ConvertTo-Json -Compress | Set-Content -LiteralPath $ElevateLog -Encoding UTF8
  }
  Write-Output ('RESULT: action=elevate launched=False declined=True target=' + $Action + ' parentPid=' + $ParentPid + ' window=hidden')
} else {
  Write-Output ('RESULT: action=' + $Action + ' ok=true monitor=false device=ROOT\DISPLAY\0000')
}
