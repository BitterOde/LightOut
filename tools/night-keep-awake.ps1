# night-keep-awake.ps1 -- keep this laptop working overnight with the screen dark.
#
# Why this script exists
# ----------------------
#   dsh-keep-awake (already installed, currently holding) uses
#   SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED). Microsoft documents
#   that this CANNOT stop user-initiated sleep:
#     "SetThreadExecutionState cannot be used to prevent the user from putting the
#      computer to sleep. Applications should respect that the user expects a certain
#      behavior when closing the lid of the laptop or pressing the power button."
#   (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
#   A power scheme that stores no explicit LIDACTION value silently inherits the shipped
#   default (1 = Sleep), and a closed lid then drops the machine into Modern Standby
#   (S0 low power idle) -- i.e. DSH stops working.
#
#   The only reliable switch is the power policy itself.
#
# Modes
# -----
#   -Status                 (default) print the effective values, change nothing
#   -Apply                  write the overnight profile:
#                             STANDBYIDLE   = 0   (never idle to sleep)
#                             UNATTENDSLEEP = 0   (never "wake then sleep again after 2 min")
#                             LIDACTION     = 0   (only with -LidNothing, see below)
#                             VIDEOIDLE     = n   (only with -DisplayTimeoutMin)
#   -Revert                 restore the baseline recorded by -Apply
#   -IncludeBattery         also write the DC (on-battery) values; default is AC only
#   -LidNothing             OPT IN to "closing the lid does nothing". Read the trade-off
#                           before using it on a laptop that runs at full load overnight:
#                             * a power scheme that stores no LIDACTION value falls back to
#                               the shipped default 1 = Sleep, so the lid sleeping the
#                               machine is the COMMON case, not an exotic one;
#                             * several vendors' thermal protection forces sleep anyway
#                               when a closed lid blocks the air intake (ASUS documents
#                               exactly this), and an overnight full-load run is hot;
#                             * closing the lid is NOT guaranteed to turn the panel off.
#                           Recommended alternative: keep the lid open and use
#                           -DisplayTimeoutMin 5, so the screen goes dark on its own.
#   -DisplayTimeoutMin <n>  display idle timeout in minutes (screen off, system stays up)
#
# HIBERNATEIDLE is deliberately NOT written: 0 there means "hibernate at the adaptive
# threshold", NOT "never" (learn.microsoft.com/.../sleep-settings-hibernate-idle-timeout).
# It only counts time already spent asleep, so it is irrelevant once idle sleep is off.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and would
# render non-ASCII literals as mojibake.

[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Apply,
  [switch]$Revert,
  [switch]$IncludeBattery,
  [switch]$LidNothing,
  [int]$DisplayTimeoutMin = -1
)

$ErrorActionPreference = 'Stop'

$SCHEME      = '381b4222-f694-41f0-9685-ff5bb260df2e'   # Balanced
$SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347'
$SUB_SLEEP   = '238c9fa8-0aad-41ed-83f4-97be242c8f20'
$SUB_VIDEO   = '7516b95f-f776-4464-8c53-06167f40cc99'
$LIDACTION     = '5ca83367-6e45-459f-a27b-476b1d01c936'
$STANDBYIDLE   = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
$UNATTENDSLEEP = '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0'
$VIDEOIDLE     = '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e'

$USER_SCHEME = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\$SCHEME"
$BASELINE    = Join-Path $PSScriptRoot 'night-keep-awake.baseline.json'

# name -> @(subgroup, setting guid, meaning, powercfg path)
$ITEMS = [ordered]@{
  'LIDACTION'     = @($SUB_BUTTONS, $LIDACTION,     'Lid close action (0=nothing 1=sleep)',  'SUB_BUTTONS LIDACTION')
  'STANDBYIDLE'   = @($SUB_SLEEP,   $STANDBYIDLE,   'Sleep after idle, sec (0=never)',       'SUB_SLEEP STANDBYIDLE')
  'UNATTENDSLEEP' = @($SUB_SLEEP,   $UNATTENDSLEEP, 'Unattended sleep timeout, sec',         'SUB_SLEEP UNATTENDSLEEP')
  'VIDEOIDLE'     = @($SUB_VIDEO,   $VIDEOIDLE,     'Display off after idle, sec',           'SUB_VIDEO VIDEOIDLE')
}
$DEFAULTS = @{
  'LIDACTION'     = @(1, 1)
  'STANDBYIDLE'   = @(1800, 900)
  'UNATTENDSLEEP' = @(120, 120)
  'VIDEOIDLE'     = @(1800, 180)
}

function Get-Effective([string]$sub, [string]$guid) {
  $p = Join-Path $USER_SCHEME "$sub\$guid"
  $out = [ordered]@{ ac = $null; dc = $null }
  if (Test-Path $p) {
    $v = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
    if ($v.PSObject.Properties.Name -contains 'ACSettingIndex') { $out.ac = [int]$v.ACSettingIndex }
    if ($v.PSObject.Properties.Name -contains 'DCSettingIndex') { $out.dc = [int]$v.DCSettingIndex }
  }
  [pscustomobject]$out
}

function Show-Table {
  Write-Host ''
  Write-Host ('{0,-15} {1,-34} {2,10} {3,10}' -f 'SETTING', 'MEANING', 'AC', 'DC')
  Write-Host ('-' * 76)
  foreach ($k in $ITEMS.Keys) {
    $i = $ITEMS[$k]
    $e = Get-Effective $i[0] $i[1]
    $ac = if ($null -eq $e.ac) { 'unset' } else { $e.ac }
    $dc = if ($null -eq $e.dc) { 'unset' } else { $e.dc }
    Write-Host ('{0,-15} {1,-34} {2,10} {3,10}' -f $k, $i[2], $ac, $dc)
  }
  Write-Host ''
  Write-Host 'unset = the scheme stores no value, so the shipped default applies.'
  Write-Host ''
}

function Set-Value([string]$cmdPath, [int]$value, [string]$scope) {
  $switch = if ($scope -eq 'ac') { '/setacvalueindex' } else { '/setdcvalueindex' }
  $argv = @($switch, 'SCHEME_CURRENT') + ($cmdPath -split ' ') + @([string]$value)
  & powercfg.exe @argv | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("powercfg {0} {1} {2} failed with exit {3}" -f $switch, $cmdPath, $value, $LASTEXITCODE) }
  Write-Host ("  [ok] {0} {1} = {2}" -f $scope, $cmdPath, $value)
}

function Save-Baseline {
  $snap = [ordered]@{}
  foreach ($k in $ITEMS.Keys) { $snap[$k] = Get-Effective $ITEMS[$k][0] $ITEMS[$k][1] }
  $snap['_capturedAt'] = (Get-Date).ToString('s')
  ($snap | ConvertTo-Json -Depth 5) | Set-Content -Path $BASELINE -Encoding ASCII
  Write-Host ("baseline written: {0}" -f $BASELINE)
}

function Restore-Baseline {
  if (-not (Test-Path $BASELINE)) { throw "no baseline file at $BASELINE; run -Apply first" }
  $b = Get-Content -Raw -Path $BASELINE | ConvertFrom-Json
  foreach ($k in $ITEMS.Keys) {
    $entry = $b.$k
    foreach ($scope in @('ac', 'dc')) {
      $val = $entry.$scope
      if ($null -eq $val) {
        $val = if ($scope -eq 'ac') { $DEFAULTS[$k][0] } else { $DEFAULTS[$k][1] }
        Write-Host ("  [{0}] {1} was unset -> writing shipped default {2}" -f $scope, $k, $val)
      }
      Set-Value $ITEMS[$k][3] ([int]$val) $scope
    }
  }
  & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
}

if (-not ($Status -or $Apply -or $Revert)) { $Status = $true }

Write-Host '=== night-keep-awake ==='
Show-Table

if ($Revert) {
  Write-Host 'Restoring baseline ...'
  Restore-Baseline
  Show-Table
  exit 0
}

if (-not $Apply) {
  Write-Host 'Report only. Options:'
  Write-Host '  -Apply                      never idle-sleep (AC)'
  Write-Host '  -Apply -IncludeBattery      same for on-battery'
  Write-Host '  -Apply -LidNothing          also: closing the lid does nothing (read the header first)'
  Write-Host '  -Apply -DisplayTimeoutMin 5 screen goes dark after 5 min, system keeps running'
  exit 0
}

Write-Host 'Applying overnight profile ...'
Save-Baseline

Set-Value $ITEMS['STANDBYIDLE'][3]   0 'ac'
Set-Value $ITEMS['UNATTENDSLEEP'][3] 0 'ac'
if ($IncludeBattery) {
  Set-Value $ITEMS['STANDBYIDLE'][3]   0 'dc'
  Set-Value $ITEMS['UNATTENDSLEEP'][3] 0 'dc'
}

if ($LidNothing) {
  Write-Host '  [warn] lid-close will no longer sleep the machine.'
  Write-Host '         Vendors document that thermal protection can still force sleep when a'
  Write-Host '         closed lid blocks the air intake, and the panel is not guaranteed to'
  Write-Host '         go dark. Keeping the lid open + -DisplayTimeoutMin is safer.'
  Set-Value $ITEMS['LIDACTION'][3] 0 'ac'
  if ($IncludeBattery) { Set-Value $ITEMS['LIDACTION'][3] 0 'dc' }
} else {
  Write-Host '  [skip] LIDACTION untouched: closing the lid still sleeps the machine.'
}

if ($DisplayTimeoutMin -ge 0) {
  $sec = [int]($DisplayTimeoutMin * 60)
  Set-Value $ITEMS['VIDEOIDLE'][3] $sec 'ac'
  if ($IncludeBattery) { Set-Value $ITEMS['VIDEOIDLE'][3] $sec 'dc' }
}

& powercfg.exe /setactive SCHEME_CURRENT | Out-Null
Write-Host 'Activated.'
Show-Table

Write-Host 'Verify (run the first one from an ELEVATED shell):'
Write-Host '  powercfg /requests    # a SYSTEM request from the keep-awake helper proves idle sleep is blocked'
Write-Host '  powercfg /a           # re-check available sleep states'
Write-Host ''
Write-Host 'Revert with:  .\night-keep-awake.ps1 -Revert'
