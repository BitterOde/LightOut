# vdd-enabled.ps1 -- offline stub for vdd-device.ps1 with the device ENABLED.
#
# Used by test/host.test.mjs so the host-half wiring can be exercised without touching the
# real device. Writes its invocations to $env:LIGHTOUT_TEST_MARKER when set.
#
# ASCII-only (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI). No inline `if`
# expressions: PowerShell 5.1 does not have them.

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

$common = 'device=ROOT\DISPLAY\0000 disabled=False monitor=1 driverStore=True deviceChoice=managed deviceCount=2'

if ($Action -eq 'status') {
  Write-Output 'device   : ROOT\DISPLAY\0000  status=OK  name=Virtual Display Driver (stub)'
  Write-Output 'config   : ConfigFlags=0  disabled=False'
  Write-Output 'monitor  : present (Generic Monitor (VDD by MTT))   [present-only]'
  Write-Output 'topology : activePaths=1 internalActive=True vddActive=False'
  Write-Output ('RESULT: action=state ' + $common + ' admin=True topology=activePaths=1 internalActive=True vddActive=False')
} elseif ($Action -eq 'verify') {
  Write-Output 'device      : ROOT\DISPLAY\0000  status=OK  disabled=False'
  Write-Output 'vdd driver  : 1.2.3.4  inf=oem88.inf  driverStore=True'
  Write-Output 'baseline    : recorded=2026-09-26T11:00:00  gpuChanged=False  vddChanged=False'
  Write-Output ('RESULT: action=verify ok=true ' + $common + ' driverVersion=1.2.3.4 infName=oem88.inf gpuCount=1 gpuChanged=False vddChanged=False verdict=ready topology=activePaths=1 internalActive=True vddActive=False')
} else {
  Write-Output ('RESULT: action=' + $Action + ' ok=true monitor=true device=ROOT\DISPLAY\0000')
}
