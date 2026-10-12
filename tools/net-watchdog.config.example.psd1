# net-watchdog.config.example.psd1 -- copy to net-watchdog.config.psd1 and edit.
#
# This file is OPTIONAL and intentionally not versioned: it holds the values that are
# specific to one machine/network, so the script itself stays generic.
#
# Every key is optional. Precedence: command-line parameter > this file > auto-detect.
# Auto-detect picks the single connected WLAN interface and its current SSID; probes are
# calibrated by a reachability sweep against the live link.
#
# Verify before trusting it (writes nothing, resets nothing):
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\net-watchdog.ps1 -Once -DryRun
@{
  # Wireless interface name as shown by Get-NetAdapter (e.g. 'WLAN', 'Wi-Fi').
  InterfaceAlias = 'WLAN'

  # Saved WLAN profile to re-associate with (netsh wlan show profiles).
  Ssid           = 'YOUR-SSID'

  # TCP host:port probes. Keep at least two, on different hosts, that YOUR network
  # actually answers. Anything unreachable here looks like an outage and resets the
  # adapter in a loop -- calibrate with -Once -DryRun and read the log first.
  Probe          = @('114.114.114.114:53', 'www.baidu.com:443')

  IntervalSec    = 120
  FailThreshold  = 2
  CooldownSec    = 300
  ProbeTimeoutMs = 4000

  # Where the rolling log goes; '' means "next to the script".
  LogPath        = ''

  # Steps 2 and 3 of the repair ladder need administrator rights. The scheduled task
  # registered by install-night-tasks.ps1 runs with -RunLevel Highest, so set this to
  # $true only if you registered that task deliberately.
  AllowWlanSvcRestart = $false
}
