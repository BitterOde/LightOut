# lightout-hold.ps1 -- keep the machine working while the panel is dark.
#
# Why this exists
#   With the internal panel out of the active topology (lightout-topology.ps1 -Action dark)
#   the panel is dark but Windows still owns an active display. The only trigger left that
#   could still put the box into a Modern Standby session (where DAM freezes every desktop
#   process, DSH included) is the idle path: the display idle timeout turning the virtual
#   display off, or the system idle sleep. Those two are exactly what
#   PowerRequestDisplayRequired / PowerRequestSystemRequired are for -- and unlike an
#   explicit SC_MONITORPOWER, which this machine treats as a SleepButton action that
#   terminates power requests, the idle timers are blocked by them.
#
# Actions
#   dark      take both requests -> topology to the virtual display only -> stay resident
#             until the first keyboard/mouse input, -MaxSeconds, or the process named by
#             -ParentPid disappearing; then restore the topology and lock the workstation
#   restore   go back to the saved layout (the host's escape hatch: POST /api/dsh-lightout/on)
#
# Safety
#   * the topology switch is validated and re-checked; if it did not leave exactly the
#     virtual display active, the saved layout is restored immediately
#   * -MaxSeconds is an absolute deadline, so even if the box DID sleep the restore runs
#     the moment this process gets to run again
#   * -ParentPid is the "the thing that asked for this is gone" guard: pass the DSH host pid
#     and the panel comes back by itself instead of waiting out the deadline
#   * -StateFile is the receipt the host half polls. Every way this guard can end writes it:
#     a failed restore keeps ok=false + restoreFailed=true so the host watchdog finishes the
#     job, a crash writes reason=guard-crashed (also with ok=false), and ONLY a successful
#     restore deletes it. A guard must never die silently -- with no receipt on disk neither
#     the watchdog nor /off's guardGone branch has anything to act on.
#   * everything this script changes is temporary: the saved layout is untouched and a
#     reboot restores it too
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
  [ValidateSet('dark', 'restore')]
  [string]$Action = '',
  # Safety net: never stay dark longer than this (absolute, survives a freeze).
  [int]$MaxSeconds = 300,
  [int]$PollMs = 200,
  # How long the topology restore is retried before giving up, in seconds. Deliberately NOT
  # derived from -MaxSeconds: that is the DARK WINDOW cap (8 h by default), and deriving the
  # retry window from it meant a refused SetDisplayConfig was retried every ~2 s for eight
  # hours. Every retry starts two PowerShell processes that recompile the C# helper below,
  # so the machine burned a whole core (fans) while the panel was reconfigured over and over
  # (flicker). That is the 2026-09-26 incident; keep this cap small and explicit.
  [int]$RestoreSeconds = 60,
  # The process that asked for the dark window. When it disappears, stop holding and restore:
  # the panel must never stay dark after the thing that wanted it is gone. 0 = do not watch.
  [int]$ParentPid = 0,
  # Where the topology executor lives (default: next to this script).
  [string]$TopologyScript = '',
  [string]$StateFile = "$env:TEMP\lightout-hold.json",
  # Rehearsal only: print what `dark` WOULD do. No power request, no topology switch, no lock.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$SCRIPT_DIR = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ($TopologyScript -eq '') { $TopologyScript = Join-Path $SCRIPT_DIR 'lightout-topology.ps1' }

# An empty -StateFile is refused outright. `$StateFile + '.lock'` would collapse to '.lock' and
# take the guard lock in the CURRENT DIRECTORY, and every later `Set-Content -LiteralPath ''` is a
# terminating parameter-binding error -- which, after the topology switch, used to leave the panel
# dark with no receipt (nothing left for the host watchdog to act on).
if ([string]::IsNullOrWhiteSpace($StateFile)) {
  [pscustomobject]@{
    action = $Action
    ok     = $false
    reason = 'state-file-required'
    error  = '-StateFile must not be empty: an empty path would lock a file in the current directory'
    when   = (Get-Date).ToString('s')
  } | ConvertTo-Json -Compress
  exit 2
}

if (-not ('LightOut.Hold' -as [type])) {
  Add-Type -Namespace LightOut -Name Hold -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT_SIMPLE ctx);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool PowerSetRequest(IntPtr powerRequest, int requestType);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool PowerClearRequest(IntPtr powerRequest, int requestType);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr h);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool LockWorkStation();

[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct REASON_CONTEXT_SIMPLE {
  public uint Version;
  public uint Flags;
  public IntPtr SimpleReasonString;
}

[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

public static IntPtr NewRequest(string reason) {
  REASON_CONTEXT_SIMPLE ctx = new REASON_CONTEXT_SIMPLE();
  ctx.Version = 0;
  ctx.Flags = 1;
  ctx.SimpleReasonString = Marshal.StringToHGlobalUni(reason);
  return PowerCreateRequest(ref ctx);
}

public static uint LastInputTick() {
  LASTINPUTINFO info = new LASTINPUTINFO();
  info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
  GetLastInputInfo(ref info);
  return info.dwTime;
}
'@
}

# ---------------------------------------------------------------- single-guard lock
# Only ONE guard may hold the machine dark at a time. Two guards take the same power
# requests, drive the same topology and then race on the restore: whichever one locks the
# session first makes every later SetDisplayConfig fail with ERROR_ACCESS_DENIED, and the
# loser then sits in the retry loop for the whole retry window. The lock is a file handle
# held open with FileShare.None for the lifetime of this process -- the OS releases it when
# the process dies, so a leftover lock file can never block a future guard.
$GUARD_LOCK = [System.IO.Path]::GetFullPath($StateFile) + '.lock'
$script:guardLock = $null
$script:guardLockError = ''

function Enter-GuardLock {
  if ($script:guardLock -ne $null) { return $true }
  try {
    $script:guardLock = [System.IO.File]::Open($GUARD_LOCK, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $true
  } catch {
    $script:guardLock = $null
    $script:guardLockError = [string]$_.Exception.Message
    return $false
  }
}

# The receipt is a JSON file written by this script and polled by the host half.
function Read-HoldReceipt {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

# Who REALLY holds the guard? The lock file only says "somebody has it open"; the receipt says
# whether a live process is responsible. Both facts are reported separately on refusal, because
# "a guard is already running" and "the lock could not be taken at all" need different reactions
# (the old code reported guard-already-running for both, which was simply not true).
function Get-GuardHolderPid {
  $r = Read-HoldReceipt
  if ($null -eq $r -or -not $r.pid) { return 0 }
  $pidValue = [int]$r.pid
  if ((Get-Process -Id $pidValue -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { return $pidValue }
  return 0
}

function Invoke-Topology([string]$Mode) {
  if (-not (Test-Path -LiteralPath $TopologyScript)) { return ('(topology script missing: ' + $TopologyScript + ')') }
  # Child-process stderr must never become a terminating error here. With EAP=Stop a single
  # "Write-Error" line from the child (exit code 0!) makes the redirection `2>&1` throw a
  # RemoteException in THIS process -- and if that happens after the panel went dark but
  # before the receipt was written, the guard dies with no receipt, so neither the host
  # watchdog (it requires a receipt) nor /off's guardGone branch can bring the panel back.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $TopologyScript -Action $Mode 2>&1
    return (($out | Out-String).Trim())
  } catch {
    # Belt and braces: even a failure to start the child must come back as text, never as an
    # exception that kills the guard.
    return ('topology ' + $Mode + ' call failed: ' + [string]$_.Exception.Message)
  } finally {
    $ErrorActionPreference = $previous
  }
}

# The topology script prints two different shapes: `check` emits the machine-readable
# `internalActive=True`, while `restore` re-prints the human list, where the same fact reads
# `[0] internal active=True` (with a space). Matching only the machine shape silently made
# the "parse restore output first, save a process" shortcut a no-op.
function Test-PanelBack([string]$text) {
  return [bool]($text -match 'internal\s*active\s*=\s*True|internalActive=True')
}

function Get-TopologyCheck {
  return (Invoke-Topology 'check')
}

function Test-SessionLocked {
  (Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
}

# The receipt has to be readable by the host half, so it is always the same JSON shape. The
# return value is the write error ('' on success) -- it is reported in the stdout line instead
# of being written to stdout on its own, because the host parses the LAST stdout line as JSON.
function Save-HoldReceipt($obj) {
  try {
    ($obj) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
    return ''
  } catch {
    return [string]$_.Exception.Message
  }
}

function Emit-Result($result, [string]$receiptError) {
  if ($receiptError -ne '') { $result.receiptError = $receiptError }
  ($result) | ConvertTo-Json -Depth 5 -Compress
}

# ------------------------------------------------------------------ request handling

$script:held = @()   # list of @(handle, type)

function Acquire-Hold {
  $script:held = @()
  $notes = @()
  $h = [LightOut.Hold]::NewRequest('dsh-lightout: dark mode, session must keep working')
  if ($h -eq [IntPtr]::Zero) {
    $notes += ('PowerCreateRequest FAILED err=' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    return @{ ok = $false; notes = $notes }
  }
  $notes += ('PowerCreateRequest ok handle=' + $h)
  $okAll = $true
  foreach ($t in @(0, 1)) {   # 0 = PowerRequestDisplayRequired, 1 = PowerRequestSystemRequired
    $ok = [LightOut.Hold]::PowerSetRequest($h, $t)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $notes += ('PowerSetRequest type=' + $t + ' -> ' + $ok + ' (err=' + $err + ')')
    if ($ok) { $script:held += , @($h, $t) } else { $okAll = $false }
  }
  return @{ ok = $okAll; notes = $notes; handle = $h }
}

function Release-Hold {
  foreach ($pair in $script:held) {
    [void][LightOut.Hold]::PowerClearRequest($pair[0], $pair[1])
    [void][LightOut.Hold]::CloseHandle($pair[0])
  }
  $script:held = @()
}

# ------------------------------------------------------------------ actions

switch ($Action) {

  'restore' {
    $t = Invoke-Topology 'restore'
    $check = Get-TopologyCheck
    $restored = Test-PanelBack $check
    if ($restored) {
      # Only a real restore clears the receipt. Removing it unconditionally (the old code) hid a
      # failed restore from the host watchdog: the escape hatch then reported success while the
      # panel was still dark, and nothing was left on disk to finish the job.
      if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
    } else {
      $failed = [ordered]@{
        action        = 'restore'
        ok            = $false
        restored      = $false
        restoreFailed = $true
        at            = (Get-Date).ToString('s')
        topology      = $t
        check         = $check
      }
      $receiptError = Save-HoldReceipt $failed
    }
    [pscustomobject]@{
      action   = 'restore'
      ok       = $restored
      restored = $restored
      topology = $t
      check    = $check
      when     = (Get-Date).ToString('s')
    } | ConvertTo-Json -Depth 4 -Compress
    if (-not $restored) { exit 5 }
  }

  'dark' {
    if ($DryRun) {
      [pscustomobject]@{ action = 'dark'; dryRun = $true; wouldHold = 'DisplayRequired+SystemRequired'; wouldSwitch = 'topology dark'; wouldLock = $true; maxSeconds = $MaxSeconds; stateFile = $StateFile; when = (Get-Date).ToString('s') } | ConvertTo-Json -Compress
      break
    }

    # Second line of defence behind the host half: never stack a second guard. A running
    # guard's receipt is deliberately left untouched here (the host watchdog must keep
    # seeing it), so this exits without writing the state file.
    if (-not (Enter-GuardLock)) {
      $holderPid = Get-GuardHolderPid
      $receipt = Read-HoldReceipt
      [pscustomobject]@{
        action     = 'dark'
        ok         = $false
        reason     = $(if ($holderPid -gt 0) { 'guard-already-running' } else { 'guard-lock-unavailable' })
        guardLock  = $GUARD_LOCK
        lockError  = $script:guardLockError
        guardPid   = $(if ($holderPid -gt 0) { $holderPid } else { $null })
        receiptPid = $(if ($null -ne $receipt) { $receipt.pid } else { $null })
        stateFile  = $StateFile
        when       = (Get-Date).ToString('s')
      } | ConvertTo-Json -Compress
      exit 3
    }

    $started = Get-Date
    $deadline = $started.AddSeconds($MaxSeconds)
    $result = [ordered]@{ action = 'dark'; startedAt = $started.ToString('s'); maxSeconds = $MaxSeconds; pid = $PID }
    $receiptError = ''

    try {
      $baseline = [LightOut.Hold]::LastInputTick()

      $acq = Acquire-Hold
      $result.hold = $acq.ok
      $result.holdNotes = $acq.notes
      if (-not $acq.ok) {
        $result.ok = $false
        $result.reason = 'could not take the power requests'
        # Receipt FIRST, release after: the host polls this file and treats "pid is gone with no
        # receipt" as guard-exited, which would hide the real reason.
        $receiptError = Save-HoldReceipt $result
        Release-Hold
        Emit-Result $result $receiptError
        break
      }

      $sw = Invoke-Topology 'dark'
      $result.topologySwitch = $sw
      $check = Get-TopologyCheck
      $result.checkAfterSwitch = $check

      $switched = ($sw -match 'apply=0') -and ($check -match 'activePaths=[1-9]') -and ($check -match 'internalActive=False')
      if (-not $switched) {
        $result.ok = $false
        $result.reason = 'topology did not end up on the virtual display only'
        $result.topologyRestore = (Invoke-Topology 'restore')
        $receiptError = Save-HoldReceipt $result
        Release-Hold
        Emit-Result $result $receiptError
        break
      }

      # Do NOT lock here. SetDisplayConfig requires access to the CURRENT desktop and returns
      # ERROR_ACCESS_DENIED (5) while the workstation is locked, so a session that is locked
      # during the dark window can never bring the panel back (learned the hard way on
      # 2026-09-26 11:11: the guard locked first, then the restore failed and the panel stayed
      # dark). The lock therefore happens AFTER the topology is restored, on wake.
      $result.lockedWhileDark = $false
      $result.deadline = $deadline.ToString('s')
      $receiptError = Save-HoldReceipt $result

      $exit = 'input'
      while ($true) {
        Start-Sleep -Milliseconds $PollMs
        if ([LightOut.Hold]::LastInputTick() -ne $baseline) { $exit = 'input'; break }
        if ((Get-Date) -ge $deadline) { $exit = 'deadline'; break }
        if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $exit = 'parent-gone'; break }
      }
      $result.exitReason = $exit

      # Panel back FIRST (retried, because the call is refused while the session is locked),
      # then lock so the returning user lands on the sign-in screen.
      $restored = $false
      $attempts = 0
      $restoreDeadline = (Get-Date).AddSeconds($RestoreSeconds)
      while ((Get-Date) -lt $restoreDeadline) {
        $attempts++
        $out = Invoke-Topology 'restore'
        $result.topologyRestore = $out
        # The restore action already prints the resulting topology, so parse it first and only
        # spend a second PowerShell process when that answer is not conclusive.
        if (Test-PanelBack $out) { $restored = $true; break }
        # SetDisplayConfig is refused with ERROR_ACCESS_DENIED while the workstation is locked,
        # so retrying in that state can only burn CPU: give up after one real attempt (plus the
        # re-check) and leave the receipt for the host watchdog, which retries once the user is
        # back at a usable desktop. Testing the lock BEFORE the attempt (the old order) skipped
        # the restore completely whenever LogonUI was still up -- including the first pass, when
        # nothing had been tried yet.
        $chk = Get-TopologyCheck
        $result.checkAfterRestore = $chk
        if (Test-PanelBack $chk) { $restored = $true; break }
        if (Test-SessionLocked) { $result.restoreBlockedByLock = $true; break }
        Start-Sleep -Seconds 2
      }
      $result.restoreAttempts = $attempts
      $result.restored = $restored
      if ($restored) {
        # The return value is checked: reporting "locked" while the desktop is still unlocked
        # would be a silent security-relevant failure.
        $result.locked = $false
        if ([LightOut.Hold]::LockWorkStation()) { $result.locked = $true } else { $result.lockFailed = $true }
      } else {
        $result.locked = $false
        # restoreFailed tells the host half this is NOT a self-cleaning failure receipt: the
        # panel may still be dark, so the receipt has to stay and the watchdog must finish it.
        $result.restoreFailed = $true
        $result.note = 'panel could not be restored (session locked?); hold released, the receipt stays so the host watchdog can finish the restore'
      }
      Release-Hold
      $result.totalMs = [int]((Get-Date) - $started).TotalMilliseconds
      $result.ok = $restored
      if ($restored) {
        if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
      } else {
        # Write $result back and KEEP it: ok=false + restoreFailed=true is what tells the host
        # watchdog to take over (with its 20 s backoff) instead of guessing from a timeout.
        $receiptError = Save-HoldReceipt $result
      }
      Emit-Result $result $receiptError
    } catch {
      # Nothing may ever kill this guard silently. If an exception escapes after the topology
      # switch and before the receipt exists, the panel stays dark and neither the host watchdog
      # (it needs a receipt) nor /off's guardGone branch (it only reports) can bring it back.
      $result.ok = $false
      $result.reason = 'guard-crashed'
      $result.error = [string]$_.Exception.Message
      $chk = Get-TopologyCheck
      $result.checkAfterCrash = $chk
      if (Test-PanelBack $chk) {
        $result.restored = $true
        $result.restoreFailed = $false
        $result.note = 'guard crashed, but the internal panel is active: nothing left to restore'
      } else {
        $result.topologyRestore = Invoke-Topology 'restore'
        $after = Get-TopologyCheck
        $result.checkAfterRestore = $after
        $result.restored = Test-PanelBack $after
        $result.restoreFailed = (-not $result.restored)
        $result.note = 'guard crashed with the panel possibly still dark; the receipt stays so the host watchdog can finish the restore'
      }
      Release-Hold
      $result.totalMs = [int]((Get-Date) - $started).TotalMilliseconds
      $receiptError = Save-HoldReceipt $result
      Emit-Result $result $receiptError
      exit 4
    }
  }

  default {
    [pscustomobject]@{ action = 'none'; ok = $false; reason = 'unknown-action'; got = $Action; expected = 'dark | restore'; when = (Get-Date).ToString('s') } | ConvertTo-Json -Compress
    exit 2
  }
}
