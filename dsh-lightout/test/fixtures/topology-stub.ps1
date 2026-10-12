# topology-stub.ps1 -- offline stub for lightout-topology.ps1.
#
# check reports the panel as NOT active until "restore" has been called, which is exactly the
# state the host-side watchdog must detect and fix. Calls are appended to $env:LIGHTOUT_TEST_MARKER.
#
# Optional env knobs (used by test/host.test.mjs):
#   LIGHTOUT_TEST_TOPO_FAIL=1        -- "restore" never takes effect (check keeps saying the
#                                       panel is dark): drives the watchdog's failure/backoff path.
#   LIGHTOUT_TEST_TOPO_DELAY_MS=<n>  -- make "restore" slow, so overlapping watchdog ticks
#                                       would be visible in the marker ordering.
#
# ASCII-only.

param(
  [ValidateSet('status', 'check', 'normalize', 'dark', 'restore')]
  [string]$Action = 'status',
  [switch]$Force,
  [switch]$DryRun
)

if ($env:LIGHTOUT_TEST_MARKER) {
  Add-Content -LiteralPath $env:LIGHTOUT_TEST_MARKER -Value ('topology:' + $Action) -Encoding UTF8
}

switch ($Action) {
  'check' {
    if ($env:LIGHTOUT_TEST_TOPO_STATE -and (Test-Path $env:LIGHTOUT_TEST_TOPO_STATE)) {
      'activePaths=1 internalActive=True vddActive=False vddTargets=1'
    } else {
      'activePaths=1 internalActive=False vddActive=True vddTargets=1'
    }
  }
  'restore' {
    if ($env:LIGHTOUT_TEST_TOPO_DELAY_MS) { Start-Sleep -Milliseconds ([int]$env:LIGHTOUT_TEST_TOPO_DELAY_MS) }
    if ($env:LIGHTOUT_TEST_TOPO_FAIL) {
      if ($env:LIGHTOUT_TEST_MARKER) { Add-Content -LiteralPath $env:LIGHTOUT_TEST_MARKER -Value 'topology:restore:failed' -Encoding UTF8 }
      '{"ok":false,"action":"restore","apply":5}'
    } else {
      if ($env:LIGHTOUT_TEST_TOPO_STATE) { Set-Content -LiteralPath $env:LIGHTOUT_TEST_TOPO_STATE -Value 'restored' -Encoding UTF8 }
      if ($env:LIGHTOUT_TEST_MARKER) { Add-Content -LiteralPath $env:LIGHTOUT_TEST_MARKER -Value 'topology:restore:done' -Encoding UTF8 }
      '{"ok":true,"action":"restore","apply":0}'
    }
  }
  default { '{"ok":true,"action":"' + $Action + '","apply":0}' }
}
