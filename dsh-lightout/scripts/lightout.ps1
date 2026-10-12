# lightout.ps1 -- read-only power-button policy report for dsh-lightout.
#
# The removed "screen-off broadcast" executor (off / on) is not part of this repository:
# route: on this machine a console display-off is recorded as a SleepButton action and drops the
# box into a Modern Standby session where DAM freezes every desktop process, DSH included
# (2026-09-26: 94.5 s and 52 min stalls). The supported route is lightout-topology.ps1 driven by
# there is no rollback switch. The supported route is lightout-topology.ps1 driven by lightout-hold.ps1.
#
# What is left is the only thing the host still consumes from this file: the effective power
# button action. It is READ here, never written -- changing the power policy needs an
# administrator and is deliberately not part of this plugin (the README lists the commands).
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
  [ValidateSet('status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# SCHEME = the built-in "Balanced" scheme; SUB_BUTTONS carries the button-action settings.
$SCHEME = '381b4222-f694-41f0-9685-ff5bb260df2e'
$SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347'
$SETTINGS = @{
  LIDACTION         = @($SUB_BUTTONS, '5ca83367-6e45-459f-a27b-476b1d01c936', 1)
  PBUTTONACTION     = @($SUB_BUTTONS, '7648efa3-dd9c-4e3e-b566-50f929386280', 3)
  SLEEPBUTTONACTION = @($SUB_BUTTONS, '96996bc0-ad50-47ec-923b-6f41874dd9eb', 1)
}

function Get-PolicyValue([string]$name) {
  $spec = $SETTINGS[$name]
  $userKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$SCHEME\$($spec[0])\$($spec[1])"
  $explicit = $null
  if (Test-Path $userKey) {
    $v = Get-ItemProperty -Path $userKey -ErrorAction SilentlyContinue
    if ($v.PSObject.Properties.Name -contains 'ACSettingIndex') { $explicit = [int]$v.ACSettingIndex }
  }
  $default = $spec[2]
  [pscustomobject]@{ name = $name; explicit = $explicit; schemeDefault = $default; effective = $(if ($null -ne $explicit) { $explicit } else { $default }) }
}

switch ($Action) {
  'status' {
    [pscustomobject]@{
      ok     = $true
      action = 'status'
      policy = @{
        LIDACTION         = (Get-PolicyValue 'LIDACTION')
        PBUTTONACTION     = (Get-PolicyValue 'PBUTTONACTION')
        SLEEPBUTTONACTION = (Get-PolicyValue 'SLEEPBUTTONACTION')
      }
      when   = (Get-Date).ToString('s')
    } | ConvertTo-Json -Depth 5 -Compress
  }
}
