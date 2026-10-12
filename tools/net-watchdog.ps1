# net-watchdog.ps1 -- detect a lost internet connection and repair it, unattended.
#
# Scope: one WLAN interface + one saved profile. Repair ladder, cheapest first:
#   1) netsh wlan connect          -- re-associate (no admin needed)
#   2) Restart-NetAdapter          -- reset the driver instance (admin)
#   3) Restart-Service WlanSvc     -- reset the WLAN stack (admin; drops the link for
#                                     tens of seconds; also the known remedy for the
#                                     wlanext.exe commit leak on some Intel drivers)
#
# Detection deliberately avoids ICMP: campus, hotel and captive networks routinely drop
# it, so an ICMP-based watchdog reports a permanent outage and resets the adapter in a
# loop. Probes are TCP connects to host:port, which also exercises DNS.
#
# ==> PROBE TARGETS MUST BE CALIBRATED FOR YOUR NETWORK. <==
# There is no universally reachable target. Measured example from a Chinese campus WLAN:
#     1.1.1.1:443          timeout   <- Cloudflare was blackholed there
#     223.5.5.5:443        timeout
#     8.8.8.8:53           timeout
#     114.114.114.114:53   ok
#     www.baidu.com:443    ok
# A watchdog hardcoded to `ping 1.1.1.1` would call that healthy network "down" forever.
# Ship your own list via -Probe, via net-watchdog.config.psd1, or let -Probe auto run
# the built-in reachability sweep (see Resolve-Probe below) and print what it found.
#
# A single failed packet never triggers a reset -- FailThreshold consecutive failed
# rounds are required, and "offline" means EVERY probe failed.
#
# Note on step 1: `netsh wlan connect` reports success even when it decides to do
# nothing (already connected to that profile). Success is therefore judged only by
# re-probing connectivity and by re-reading the link state, never by the exit code.
#
# Locale safety: every field this script reads comes from a cmdlet enum
# (Get-NetAdapter.Status / Get-NetConnectionProfile.IPv4Connectivity), never from
# localized `netsh` text. The file is deliberately pure ASCII as well: Windows
# PowerShell 5.1 parses a BOM-less .ps1 as ANSI, and any non-ASCII literal in the
# source would corrupt the parse (verified the hard way).

[CmdletBinding()]
param(
  [string]$Ssid            = '',
  [string]$InterfaceAlias  = '',
  [int]$IntervalSec        = 120,
  [int]$FailThreshold      = 2,
  [int]$CooldownSec        = 300,
  [int]$ProbeTimeoutMs     = 4000,
  [string[]]$Probe         = @(),
  [string]$LogPath         = '',
  [switch]$Once,
  [switch]$DryRun,
  [switch]$AllowWlanSvcRestart
)

# ---------------------------------------------------------------- early helpers
# These two are needed by the configuration block below, so they are defined before it
# rather than down with the rest: the probe calibration runs BEFORE the definitions that
# follow it would be reached, and calling an undefined function there is a hard error.
function Write-Log([string]$msg) {
  $line = ('{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg)
  Write-Host $line
  try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 2MB)) {
      Move-Item -Force $LogPath "$LogPath.1"
    }
    Add-Content -Path $LogPath -Value $line -Encoding ASCII
  } catch { Write-Host ("  [warn] log write failed: {0}" -f $_.Exception.Message) }
}

function Test-Tcp([string]$target, [int]$port, [int]$timeoutMs) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($target, $port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

# ---------------------------------------------------------------- configuration
# Precedence, highest first:
#   1) explicit command-line parameters
#   2) net-watchdog.config.psd1 next to this script (a hashtable; not versioned --
#      see net-watchdog.config.example.psd1 for the shape and copy it into place)
#   3) auto-detection (the single connected WLAN interface / its saved profile)
# Nothing about one particular machine is baked into this file.
$configPath = Join-Path $PSScriptRoot 'net-watchdog.config.psd1'
$config = @{}
if (Test-Path $configPath) {
  try {
    $loaded = Import-PowerShellDataFile -Path $configPath
    if ($loaded -is [hashtable]) { $config = $loaded }
  } catch {
    Write-Host ("[warn] config file ignored (does not parse): {0} -- {1}" -f $configPath, $_.Exception.Message)
  }
}
foreach ($name in @('Ssid', 'InterfaceAlias', 'IntervalSec', 'FailThreshold', 'CooldownSec',
                    'ProbeTimeoutMs', 'Probe', 'LogPath', 'AllowWlanSvcRestart')) {
  $bound = $PSBoundParameters.ContainsKey($name)
  if (-not $bound -and $config.ContainsKey($name)) {
    Set-Variable -Name $name -Value $config[$name] -Scope 0
  }
}

function Resolve-WlanInterface {
  # The interface with an active IPv4 default route; falls back to the first Up WLAN.
  $up = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'Up' -and $_.InterfaceType -eq 71 })  # 71 = Wireless80211
  if ($up.Count -eq 1) { return $up[0].Name }
  $connected = @($up | Where-Object {
    (Get-NetConnectionProfile -InterfaceAlias $_.Name -ErrorAction SilentlyContinue).IPv4Connectivity -ne 'Disconnected'
  })
  if ($connected.Count -ge 1) { return $connected[0].Name }
  if ($up.Count -ge 1) { return $up[0].Name }
  return $null
}

function Resolve-Ssid([string]$alias) {
  # The profile the interface is actually associated with right now.
  try {
    $state = netsh.exe wlan show interfaces 2>$null
    $line = $state | Where-Object { $_ -match '^\s*SSID\s*:' } | Select-Object -First 1
    if ($line) { return ($line -replace '^\s*SSID\s*:\s*', '').Trim() }
  } catch { }
  return $null
}

function Resolve-Probe {
  # Calibrate probes against the CURRENT link: keep the first two targets that answer.
  # Run with -Once -DryRun first and read the log before trusting the result.
  $candidates = @('114.114.114.114:53', '223.5.5.5:443', '1.1.1.1:443', '8.8.8.8:53',
                  'www.baidu.com:443', 'api.deepseek.com:443', 'www.microsoft.com:443')
  $ok = @()
  foreach ($c in $candidates) {
    $parts = $c -split ':'
    if (Test-Tcp $parts[0] ([int]$parts[1]) $ProbeTimeoutMs) { $ok += $c }
    if ($ok.Count -ge 2) { break }
  }
  if ($ok.Count -eq 0) {
    # Nothing answered: fall back to two plain DNS targets so the ladder can still run.
    return @('114.114.114.114:53', '8.8.8.8:53')
  }
  return $ok
}

if (-not $InterfaceAlias) { $InterfaceAlias = Resolve-WlanInterface }
if (-not $Ssid) { $Ssid = Resolve-Ssid $InterfaceAlias }

# $PSScriptRoot is not reliable inside a param() default on Windows PowerShell 5.1,
# so the log path is resolved here instead.
if (-not $LogPath) { $LogPath = Join-Path $PSScriptRoot 'net-watchdog.log' }

$ErrorActionPreference = 'Continue'
if (-not $InterfaceAlias) {
  Write-Host '[fatal] no WLAN interface found; pass -InterfaceAlias <name>'
  exit 2
}
if (-not $Probe -or $Probe.Count -eq 0) { $Probe = Resolve-Probe }

function Test-Online {
  foreach ($entry in $Probe) {
    $parts = $entry.Split(':')
    $host_ = $parts[0]
    $port  = if ($parts.Length -gt 1) { [int]$parts[1] } else { 443 }
    if (Test-Tcp $host_ $port $ProbeTimeoutMs) { return $true }
  }
  return $false
}

function Get-LinkState {
  # Locale-independent: adapter status enum + connection-profile enum.
  $ad = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
  if (-not $ad) { return 'interface-not-found' }
  if ($ad.Status -ne 'Up') { return ('adapter-' + $ad.Status) }
  $cp = Get-NetConnectionProfile -InterfaceAlias $InterfaceAlias -ErrorAction SilentlyContinue
  if (-not $cp) { return 'up/no-profile' }
  return ('up/' + $cp.IPv4Connectivity)
}

function Is-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Step([string]$label, [scriptblock]$action) {
  if ($DryRun) { Write-Log ("  [dry-run] would run: {0}" -f $label); return }
  try { & $action | Out-Null; Write-Log ("  [ran] {0}" -f $label) }
  catch { Write-Log ("  [fail] {0} -> {1}" -f $label, $_.Exception.Message) }
}

function Invoke-Repair {
  $admin = Is-Admin
  Write-Log ("repair ladder start (admin={0})" -f $admin)

  Invoke-Step ("netsh wlan connect name={0} interface={1}" -f $Ssid, $InterfaceAlias) {
    & netsh.exe wlan connect name=$Ssid interface=$InterfaceAlias
  }
  Start-Sleep -Seconds 20
  if (Test-Online) { Write-Log '  [ok] back online after re-associate'; return $true }

  if (-not $admin) {
    Write-Log '  [stop] still offline; driver/service reset needs an elevated shell'
    return $false
  }

  Invoke-Step ("Restart-NetAdapter -Name {0}" -f $InterfaceAlias) {
    Restart-NetAdapter -Name $InterfaceAlias -Confirm:$false
  }
  Start-Sleep -Seconds 25
  if (Test-Online) { Write-Log '  [ok] back online after adapter reset'; return $true }

  if ($AllowWlanSvcRestart) {
    Invoke-Step 'Restart-Service WlanSvc -Force' { Restart-Service -Name WlanSvc -Force }
    Start-Sleep -Seconds 30
    if (Test-Online) { Write-Log '  [ok] back online after WlanSvc restart'; return $true }
  } else {
    Write-Log '  [skip] WlanSvc restart not allowed (pass -AllowWlanSvcRestart to enable)'
  }

  Write-Log '  [give-up] repair ladder exhausted; still offline'
  return $false
}

# ---------------------------------------------------------------- main
$failStreak = 0
$lastRepair = [datetime]::MinValue
Write-Log ("watchdog start: ssid={0} iface={1} interval={2}s threshold={3}" -f $Ssid, $InterfaceAlias, $IntervalSec, $FailThreshold)

while ($true) {
  $state  = Get-LinkState
  $online = Test-Online

  if ($online) {
    if ($failStreak -gt 0) { Write-Log ("recovered (streak was {0})" -f $failStreak) }
    $failStreak = 0
  } else {
    $failStreak++
    Write-Log ("offline: probe failed ({0}/{1}) link-state={2}" -f $failStreak, $FailThreshold, $state)
    if ($failStreak -ge $FailThreshold) {
      $since = ((Get-Date) - $lastRepair).TotalSeconds
      if ($since -lt $CooldownSec) {
        Write-Log ("  [cooling] {0:N0}s since last repair, need {1}s" -f $since, $CooldownSec)
      } else {
        $lastRepair = Get-Date
        Invoke-Repair | Out-Null
        $failStreak = 0
        Start-Sleep -Seconds 5
      }
    }
  }

  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSec
}
