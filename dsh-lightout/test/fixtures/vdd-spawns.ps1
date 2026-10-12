# vdd-spawns.ps1 -- offline stub for vdd-device.ps1 whose whole job is to LEAVE A TRACE.
#
# test/host.test.mjs uses it to prove that the plugin really probes at MOUNT time:
# every spawn appends one line to $env:LIGHTOUT_TEST_SPAWN_LOG, so "how much PowerShell did
# this mount cost?" becomes a number instead of a guess. One line per spawn == one probe.
#
# The optional sleep ($env:LIGHTOUT_TEST_SPAWN_SLEEP_MS) is what makes the second half of the
# test sharp: with the probe still in flight, a /status request must JOIN it (the single-flight
# promise) instead of starting a second one -- a short sleep would race and flake.
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

if ($env:LIGHTOUT_TEST_SPAWN_LOG) {
  Add-Content -LiteralPath $env:LIGHTOUT_TEST_SPAWN_LOG -Value ('vdd:' + $Action) -Encoding UTF8
}
if ($env:LIGHTOUT_TEST_SPAWN_SLEEP_MS) {
  Start-Sleep -Milliseconds ([int]$env:LIGHTOUT_TEST_SPAWN_SLEEP_MS)
}

$common = 'device=ROOT\DISPLAY\0000 disabled=False monitor=1 driverStore=True deviceChoice=managed deviceCount=1'

if ($Action -eq 'status') {
  Write-Output 'device   : ROOT\DISPLAY\0000  status=OK  name=Virtual Display Driver (spawn stub)'
  Write-Output 'config   : ConfigFlags=0  disabled=False'
  Write-Output ('RESULT: action=state ' + $common + ' driverVersion=9.9.9.9 admin=True topology=activePaths=2 internalActive=True vddActive=True')
} elseif ($Action -eq 'verify') {
  Write-Output 'device      : ROOT\DISPLAY\0000  status=OK  disabled=False'
  Write-Output 'vdd driver  : 9.9.9.9  inf=oem99.inf  driverStore=True'
  Write-Output ('RESULT: action=verify ok=true ' + $common + ' driverVersion=9.9.9.9 infName=oem99.inf gpuCount=1 gpuChanged=False vddChanged=False verdict=ready topology=activePaths=2 internalActive=True vddActive=True')
} else {
  Write-Output ('RESULT: action=' + $Action + ' ok=true monitor=false device=ROOT\DISPLAY\0000')
}
