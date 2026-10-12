# lightout-topology.ps1 -- display-topology switch for dsh-lightout's "dark" mode.
#
# Why this exists
#   On this machine a console display-off is treated as a SleepButton action, so
#   SC_MONITORPOWER drops the box into a Modern Standby session and DAM freezes every
#   desktop process (DSH included). Instead of telling Windows "the display is off",
#   this script takes the INTERNAL panel out of the active topology while keeping the
#   virtual display (Virtual-Display-Driver / MttVDD) active: the panel loses signal and
#   goes dark, Windows still sees an active display, no standby session starts, and
#   everything keeps running.
#
# Actions
#   check      read-only: one machine-readable line for callers (activePaths / internalActive /
#              vddActive / vddTargets) -- vdd-device.ps1 refuses to enable a second virtual
#              display when vddTargets says more than one target is available.
#   normalize  make "internal panel only" the SAVED layout, so day-to-day use is unchanged
#              and the virtual display stays attached-but-inactive
#   dark       activate ONLY the virtual display -- TEMPORARY (not saved; a reboot or
#              -Action restore undoes it). This is the "panel dark, system running" state.
#   restore    go back to the saved layout (SDC_APPLY | SDC_USE_DATABASE_CURRENT)
#
# Facts learned on this machine (2026-09-26), do not "simplify" them away
#   * QDC_ALL_PATHS returns EVERY candidate path (45 of them here), mostly
#     targetAvailable=0 noise and clone variants of the same target. Only paths with
#     targetAvailable != 0 are real targets, and only ONE path per target may carry the
#     ACTIVE flag or Windows builds a clone configuration.
#   * The MttVDD monitor reports outputTechnology 0x5 (DVI), NOT the indirect-display
#     value, so the virtual display is identified by its friendly name ("VDD by MTT").
#   * The internal panel is outputTechnology 0x80000000 (INTERNAL).
#
# Safety
#   * "dark"/"normalize" refuse to run when a third kind of AVAILABLE target (an external
#     monitor) is present, unless -Force is given.
#   * "dark" validates first and re-reads the result afterwards; if no path ends up
#     active it restores the saved layout immediately. Windows rejects a zero-display
#     configuration anyway (verified: rc=87 ERROR_INVALID_PARAMETER).
#   * Only "normalize" persists anything (that is its purpose); "dark" is temporary.
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
  [ValidateSet('check', 'normalize', 'dark', 'restore')]
  [string]$Action = 'check',
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not ('LightOut.Topo' -as [type])) {
  Add-Type -Namespace LightOut -Name Topo -MemberDefinition @'
[DllImport("user32.dll")]
public static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);

[DllImport("user32.dll")]
public static extern int QueryDisplayConfig(uint flags, ref uint numPath, [Out] PATH[] paths, ref uint numMode, [Out] MODE[] modes, IntPtr topoId);

[DllImport("user32.dll")]
public static extern int SetDisplayConfig(uint numPath, [In, Out] PATH[] paths, uint numMode, [In, Out] MODE[] modes, uint flags);

[DllImport("user32.dll")]
public static extern int DisplayConfigGetDeviceInfo(ref TARGET_NAME name);

[StructLayout(LayoutKind.Sequential)]
public struct LUID { public uint LowPart; public int HighPart; }

[StructLayout(LayoutKind.Sequential)]
public struct SRC { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

[StructLayout(LayoutKind.Sequential)]
public struct RAT { public uint Numerator; public uint Denominator; }

[StructLayout(LayoutKind.Sequential)]
public struct TGT {
  public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology;
  public uint rotation; public uint scaling; public RAT refreshRate; public uint scanLineOrdering;
  public int targetAvailable; public uint statusFlags;
}

[StructLayout(LayoutKind.Sequential)]
public struct PATH { public SRC sourceInfo; public TGT targetInfo; public uint flags; }

[StructLayout(LayoutKind.Sequential)]
public struct MODE {
  public uint infoType; public uint id; public LUID adapterId;
  public ulong p0; public ulong p1; public ulong p2; public ulong p3; public ulong p4; public ulong p5;
}

[StructLayout(LayoutKind.Sequential)]
public struct DEVINFO_HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct TARGET_NAME {
  public DEVINFO_HEADER header;
  public uint flags;
  public uint outputTechnology;
  public ushort edidManufactureId;
  public ushort edidProductCodeId;
  public uint connectorInstance;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string monitorFriendlyDeviceName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string monitorDevicePath;
}

public const uint QDC_ALL_PATHS = 1;
public const uint QDC_ONLY_ACTIVE_PATHS = 2;
public const uint PATH_ACTIVE = 1;
public const uint OUTTECH_INTERNAL = 0x80000000;
public const uint SDC_USE_DATABASE_CURRENT = 0x0F;
public const uint SDC_USE_SUPPLIED = 0x20;
public const uint SDC_VALIDATE = 0x40;
public const uint SDC_APPLY = 0x80;
public const uint SDC_SAVE = 0x200;
public const uint SDC_ALLOW_CHANGES = 0x400;

public static string FriendlyName(LUID adapterId, uint targetId) {
  TARGET_NAME tn = new TARGET_NAME();
  tn.header.type = 2;
  tn.header.size = (uint)Marshal.SizeOf(typeof(TARGET_NAME));
  tn.header.adapterId = adapterId;
  tn.header.id = targetId;
  int rc = DisplayConfigGetDeviceInfo(ref tn);
  if (rc != 0) { return "(name-unavailable rc=" + rc + ")"; }
  if (tn.monitorFriendlyDeviceName == null) { return ""; }
  return tn.monitorFriendlyDeviceName.Trim();
}

public static string KindOfPath(PATH p) {
  if (p.targetInfo.outputTechnology == OUTTECH_INTERNAL) { return "internal"; }
  string nm = FriendlyName(p.targetInfo.adapterId, p.targetInfo.id);
  if (nm.ToUpperInvariant().Contains("VDD")) { return "vdd"; }
  return "other";
}

public static PATH[] Query(out MODE[] modes, out uint count, out string err) {
  modes = null; count = 0; err = null;
  uint np, nm;
  int rc = GetDisplayConfigBufferSizes(QDC_ALL_PATHS, out np, out nm);
  if (rc != 0) { err = "GetDisplayConfigBufferSizes rc=" + rc; return null; }
  PATH[] paths = new PATH[np];
  MODE[] ms = new MODE[nm];
  uint np2 = np, nm2 = nm;
  rc = QueryDisplayConfig(QDC_ALL_PATHS, ref np2, paths, ref nm2, ms, IntPtr.Zero);
  if (rc != 0) { err = "QueryDisplayConfig rc=" + rc; return null; }
  modes = ms; count = np2;
  return paths;
}

public static string Status() {
  MODE[] modes; uint n; string err;
  PATH[] paths = Query(out modes, out n, out err);
  if (paths == null) { return err; }
  System.Text.StringBuilder sb = new System.Text.StringBuilder();
  int real = 0, noise = 0;
  for (uint i = 0; i < n; i++) {
    PATH p = paths[i];
    if (p.targetInfo.targetAvailable == 0) { noise++; continue; }
    real++;
    sb.AppendLine(string.Format("[{0}] {1,-8} active={2,-5} name='{3}' outTech=0x{4:X} adapter=0x{5:X} target={6} srcId={7} modeIdx(src={8},tgt={9})",
      i, KindOfPath(p), ((p.flags & PATH_ACTIVE) != 0),
      FriendlyName(p.targetInfo.adapterId, p.targetInfo.id), p.targetInfo.outputTechnology,
      p.targetInfo.adapterId.LowPart, p.targetInfo.id, p.sourceInfo.id,
      p.sourceInfo.modeInfoIdx, p.targetInfo.modeInfoIdx));
  }
  sb.AppendLine("availablePaths=" + real + " unavailableCandidates=" + noise + " totalModes=" + (modes == null ? 0 : modes.Length));
  return sb.ToString();
}

// Activate exactly one path per available target of the given kind; every other path loses
// the ACTIVE flag. save=true persists the result as the default layout.
public static string ActivateOnly(string kind, bool save, bool force) {
  MODE[] modes; uint n; string err;
  PATH[] paths = Query(out modes, out n, out err);
  if (paths == null) { return err; }
  int others = 0;
  System.Collections.Generic.Dictionary<string, int> best = new System.Collections.Generic.Dictionary<string, int>();
  for (uint i = 0; i < n; i++) {
    PATH p = paths[i];
    if (p.targetInfo.targetAvailable == 0) { continue; }
    string k = KindOfPath(p);
    if (k == "other") { others++; continue; }
    if (k != kind) { continue; }
    string key = p.targetInfo.adapterId.LowPart.ToString() + "|" + p.targetInfo.id.ToString();
    bool isActive = (p.flags & PATH_ACTIVE) != 0;
    if (!best.ContainsKey(key)) { best[key] = (int)i; }
    else if (isActive && ((paths[best[key]].flags & PATH_ACTIVE) == 0)) { best[key] = (int)i; }
  }
  if (others > 0 && !force) {
    return "REFUSED: " + others + " available 'other' target(s) present (external display?); re-run with -Force if that is intended";
  }
  if (best.Count == 0) { return "REFUSED: no available '" + kind + "' target found"; }
  for (uint i = 0; i < n; i++) {
    bool want = false;
    foreach (System.Collections.Generic.KeyValuePair<string, int> kv in best) {
      if (kv.Value == (int)i) { want = true; break; }
    }
    if (want) { paths[i].flags = paths[i].flags | PATH_ACTIVE; }
    else { paths[i].flags = paths[i].flags & ~PATH_ACTIVE; }
  }
  uint modeCount = (uint)(modes == null ? 0 : modes.Length);
  int vr = SetDisplayConfig(n, paths, modeCount, modes, SDC_VALIDATE | SDC_USE_SUPPLIED);
  uint aflags = SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES | (save ? SDC_SAVE : 0);
  int ar = SetDisplayConfig(n, paths, modeCount, modes, aflags);
  return "kind=" + kind + " targetCount=" + best.Count + " validate=" + vr + " apply=" + ar + " saved=" + save;
}

public static string RestoreSaved() {
  int rc = SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_USE_DATABASE_CURRENT);
  return "restoreSaved rc=" + rc;
}

public static int ActivePathCount() {
  uint np, nm;
  int rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm);
  if (rc != 0) { return -1; }
  return (int)np;
}

// How many AVAILABLE targets of one kind exist (one per adapter+target id, exactly the way
// ActivateOnly groups them). Two "vdd" targets mean two virtual displays would end up active
// at once, so callers use this to refuse before they create the situation. -1 = unreadable.
public static int AvailableCount(string kind) {
  MODE[] modes; uint n; string err;
  PATH[] paths = Query(out modes, out n, out err);
  if (paths == null) { return -1; }
  System.Collections.Generic.Dictionary<string, int> seen = new System.Collections.Generic.Dictionary<string, int>();
  for (uint i = 0; i < n; i++) {
    PATH p = paths[i];
    if (p.targetInfo.targetAvailable == 0) { continue; }
    if (KindOfPath(p) != kind) { continue; }
    seen[p.targetInfo.adapterId.LowPart.ToString() + "|" + p.targetInfo.id.ToString()] = 1;
  }
  return seen.Count;
}
'@
}

function Show-Status([string]$label) {
  Write-Output ("--- " + $label + " ---")
  Write-Output ([LightOut.Topo]::Status())
}

switch ($Action) {
  'check' {
    # One machine-readable line, for callers (lightout-hold.ps1, vdd-device.ps1, tests) that must
    # not parse the human-readable list. vddTargets = how many AVAILABLE virtual-display targets
    # exist; > 1 means a second VDD instance is present and activating them all would leave two
    # virtual displays active (-1 = unreadable).
    $n = [LightOut.Topo]::ActivePathCount()
    $st = [LightOut.Topo]::Status()
    Write-Output ('activePaths=' + $n + ' internalActive=' + [bool]($st -match 'internal active=True') + ' vddActive=' + [bool]($st -match 'vdd\s+active=True') + ' vddTargets=' + [LightOut.Topo]::AvailableCount('vdd'))
  }

  'normalize' {
    if ($DryRun) { Write-Output '[dry-run] would save "internal only" as the default layout'; Show-Status 'current'; break }
    Show-Status 'before'
    Write-Output ([LightOut.Topo]::ActivateOnly('internal', $true, $Force.IsPresent))
    Start-Sleep -Seconds 2
    Show-Status 'after'
    Write-Output ('activePaths=' + [LightOut.Topo]::ActivePathCount())
  }

  'dark' {
    if ($DryRun) { Write-Output '[dry-run] would switch to "virtual display only" (temporary)'; Show-Status 'current'; break }
    Show-Status 'before'
    Write-Output ([LightOut.Topo]::ActivateOnly('vdd', $false, $Force.IsPresent))
    Start-Sleep -Seconds 2
    Show-Status 'after'
    $n = [LightOut.Topo]::ActivePathCount()
    Write-Output ('activePaths=' + $n)
    if ($n -lt 1) {
      Write-Output 'no active path left -- restoring the saved layout immediately'
      Write-Output ([LightOut.Topo]::RestoreSaved())
      Start-Sleep -Seconds 2
      Show-Status 'after-restore'
    }
  }

  'restore' {
    Write-Output ([LightOut.Topo]::RestoreSaved())
    Start-Sleep -Seconds 2
    Show-Status 'after-restore'
    Write-Output ('activePaths=' + [LightOut.Topo]::ActivePathCount())
  }
}
