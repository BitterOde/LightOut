# hold-stub.ps1 -- offline stub for lightout-hold.ps1.
#
# "dark" writes a receipt whose pid is a pid that can never be alive, so the host-side
# watchdog sees "guard is gone" and exercises the restore path deterministically.
#
# Optional env knobs (used by test/host.test.mjs):
#   LIGHTOUT_TEST_RESTORE_RECEIPT_PID -- on "restore", ALSO drop a receipt for that pid.
#                                       That is how the real /on meets a brand-new guard:
#                                       the host must not clear a live foreign receipt.
#
# ASCII-only.

param(
  [ValidateSet('dark', 'restore', 'status', 'selftest')]
  [string]$Action = 'status',
  [int]$MaxSeconds = 300,
  [int]$PollMs = 200,
  [int]$ParentPid = 0,
  [string]$TopologyScript = '',
  [string]$StateFile = '',
  [switch]$DryRun
)

if ($env:LIGHTOUT_TEST_MARKER) {
  $line = 'hold:' + $Action
  if ($ParentPid -gt 0) { $line = $line + ':parent=' + $ParentPid }
  Add-Content -LiteralPath $env:LIGHTOUT_TEST_MARKER -Value $line -Encoding UTF8
}

if ($Action -eq 'dark') {
  $obj = [ordered]@{
    action           = 'dark'
    ok               = $true
    pid              = 999999
    startedAt        = (Get-Date).ToString('s')
    deadline         = (Get-Date).AddSeconds($MaxSeconds).ToString('s')
    maxSeconds       = $MaxSeconds
    hold             = $true
    lockedWhileDark  = $false
    checkAfterSwitch = 'activePaths=1 internalActive=False vddActive=True'
  }
  ([pscustomobject]$obj) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  ([pscustomobject]$obj) | ConvertTo-Json -Depth 5 -Compress
} elseif ($Action -eq 'restore') {
  if ($env:LIGHTOUT_TEST_RESTORE_RECEIPT_PID -and $StateFile -ne '') {
    $foreign = [ordered]@{
      action     = 'dark'
      ok         = $true
      pid        = [int]$env:LIGHTOUT_TEST_RESTORE_RECEIPT_PID
      startedAt  = (Get-Date).ToString('s')
      deadline   = (Get-Date).AddHours(8).ToString('s')
      maxSeconds = 28800
    }
    ([pscustomobject]$foreign) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  }
  '{"action":"restore","ok":true,"topology":"restored-by-stub","check":"activePaths=1 internalActive=True vddActive=False"}'
} else {
  '{"action":"status","hold":false}'
}
