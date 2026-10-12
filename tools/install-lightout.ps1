# install-lightout.ps1 -- wire the dsh-lightout plugin into the web profile.
#
# Two wiring paths. Both need the same junction; they differ in WHERE the plugin row
# comes from, and therefore in WHEN it takes effect:
#
#   DEFAULT (user patch layer -- live, no restart)
#     Appends an "- insert:" block for the plugin row to
#         <profile>\cordis.patch.yml
#     The web profile runs with dsh.profile.patchReload = "live" and that file is
#     watched while dsh web is running, so the host half mounts WITHOUT restarting the
#     host. The browser half still needs a page refresh (Ctrl+Shift+R): __DSH_BOOT__
#     is delivered once per page load.
#
#   OPTIONAL -Bundles (profile bundle layer -- REQUIRES A DSH WEB RESTART)
#     Adds "dsh-lightout" to <profile>\package.json -> dsh.profile.bundles.
#     Bundles are read once at startup only, so this path takes effect after the user
#     restarts dsh web. It is the "declared as part of the profile" path; the row itself
#     still comes from the package's own dsh.bundle.patch file (cordis.patch.yml).
#
#   Use one path or the other, never both: they insert the same row id twice.
#
# Steps: validate -> junction -> row -> compose check (dsh --profile X --dump-config)
#        -> roll back everything if the compose check does not see the row.
#
# Why a junction instead of `pnpm add`: a junction is a single reversible operation with
# no package manager, no lockfile and no network. The official alternative is
#   node <dsh>\lib\bin.js plugin --profile web add link:<repo>\dsh-lightout
# (any pnpm works for that path). That command also
# reconciles dsh.profile.bundles automatically -- and it therefore also needs a restart.
#
# package.json and cordis.patch.yml are edited BYTE-SAFELY: they are decoded as UTF-8,
# only the edited span is rewritten, and the original BOM state and line endings are
# preserved. (Rule of this machine: never round-trip a source file through PowerShell
# text cmdlets -- PS 5.1 reads BOM-less UTF-8 as ANSI and destroys it.)
#
# Nothing here needs administrator rights and nothing outside the profile directory is
# touched. This script never starts, stops or restarts dsh web.
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI, so any
# non-ASCII literal in this file would corrupt the parse.

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$DryRun,
  [switch]$Bundles,
  [switch]$SkipComposeCheck,
  # The three path parameters default to '' on purpose and are resolved in the body:
  # with [CmdletBinding()] under `powershell -File`, PS 5.1 evaluates parameter defaults
  # before $PSScriptRoot exists, so a default like (Split-Path -Parent $PSScriptRoot)
  # fails with "Path is an empty string" and the script never runs.
  [string]$ProfileDir = '',
  [string]$ProfileName = 'web',
  [string]$PackageDir = '',
  [string]$DshBin = ''
)

$ErrorActionPreference = 'Stop'

$PLUGIN = 'dsh-lightout'
# NOTE: the cordis.patch.yml row id is NOT the package name. The loader entry name
# (= the package name) is what the browser half registers under, see cordis.patch.yml.
$ROW_ID = 'lightout'

function Fail([string]$message) { Write-Host ("[x] " + $message) -ForegroundColor Red; exit 1 }
function Ok([string]$message) { Write-Host ("[ok] " + $message) -ForegroundColor Green }
function Warn([string]$message) { Write-Host ("[!] " + $message) -ForegroundColor Yellow }
function Info([string]$message) { Write-Host ("    " + $message) }
function Head([string]$message) { Write-Host ("== " + $message) -ForegroundColor Cyan }

# ------------------------------------------------------- parameter resolution (body)
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrEmpty($scriptDir)) { Fail 'cannot determine the script directory; run this file from disk (-File or the call operator)' }

if ([string]::IsNullOrEmpty($ProfileDir)) { $ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web') }
if ([string]::IsNullOrEmpty($PackageDir)) { $PackageDir = (Join-Path (Split-Path -Parent $scriptDir) 'dsh-lightout') }
if ([string]::IsNullOrEmpty($DshBin)) { $DshBin = (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js') }

$LINK = Join-Path $ProfileDir "node_modules\$PLUGIN"
$MANIFEST = Join-Path $ProfileDir 'package.json'
$PATCHFILE = Join-Path $ProfileDir 'cordis.patch.yml'
$MARKER = ('# --- ' + $PLUGIN + ' (managed by tools/install-lightout.ps1; -Uninstall removes it) ---')

if (-not ($Install -or $Uninstall -or $Status)) { $Install = $true }

# ---------------------------------------------------------------- byte-safe text I/O
function Get-Text([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = if ($bom) { [Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3) } else { [Text.Encoding]::UTF8.GetString($bytes) }
  [pscustomobject]@{ text = $text; bom = $bom; bytes = $bytes }
}

function Save-Text([string]$path, [string]$text, [bool]$bom) {
  $body = [Text.Encoding]::UTF8.GetBytes($text)
  if ($bom) {
    $all = New-Object byte[] ($body.Length + 3)
    $all[0] = 0xEF; $all[1] = 0xBB; $all[2] = 0xBF
    [Array]::Copy($body, 0, $all, 3, $body.Length)
  } else {
    $all = $body
  }
  [IO.File]::WriteAllBytes($path, $all)
}

function Test-Json([string]$text) {
  try { $null = $text | ConvertFrom-Json; return $true } catch { return $false }
}

function New-BackupName([string]$base) {
  return ($base + '.bak-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '-lightout')
}

# ------------------------------------------------------ user patch layer (live layer)
function Get-RowBlock([string]$eol) {
  return (@(
    $MARKER,
    '- insert:',
    ('    - id: ' + $ROW_ID),
    ("      name: '" + $PLUGIN + "'")
  ) -join $eol)
}

function Test-UserPatchRow([string]$text) {
  return [bool]($text -match ('(?m)^\s*- id: ' + [regex]::Escape($ROW_ID) + '\s*$'))
}

# The last line that is neither blank nor a comment (a regex Match, so the caller can
# splice exactly that span). $null when the file has no content line at all.
function Get-LastContentLine([string]$text) {
  $last = $null
  foreach ($m in [regex]::Matches($text, '[^\r\n]+')) {
    if ($m.Value.TrimStart().StartsWith('#')) { continue }
    $last = $m
  }
  return $last
}

function Add-UserPatchRow([string]$text) {
  if (Test-UserPatchRow $text) { return $null }
  $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $block = Get-RowBlock $eol
  $last = Get-LastContentLine $text
  if ($last -ne $null -and $last.Value.Trim() -eq '[]') {
    # Factory-state profile: the shipped template ends with a bare flow sequence "[]"
    # (an empty patch array). Appending after it would put a SECOND top-level node into
    # the same YAML document, which the loader rejects with
    #   YAMLException: end of the stream or a document separator is expected
    # and the profile would then fail to start. Replace that line instead of appending.
    $next = $text.Substring(0, $last.Index) + $block + $text.Substring($last.Index + $last.Length)
    if (-not $next.EndsWith($eol)) { $next = $next + $eol }
    return $next
  }
  $lead = if ($text.Length -eq 0 -or $text.EndsWith($eol)) { '' } else { $eol }
  return ($text + $lead + $block + $eol)
}

function Remove-UserPatchRow([string]$text) {
  $quoted = [regex]::Escape("'" + $PLUGIN + "'")
  # The row may carry an optional config: block -- that is the documented way to tune the
  # plugin from the profile (README: dryRun / lockDelayMs / the timing knobs). Those lines
  # are indented 6+ spaces, so they are consumed too; otherwise -Uninstall would leave an
  # orphan "config:" at top level and the patch file would stop being valid YAML.
  $tail = ('- insert:\r?\n[ ]+- id: ' + [regex]::Escape($ROW_ID) + '\r?\n[ ]+name: ' + $quoted + '(?:\r?\n[ ]{6,}\S.*)*\r?\n')
  $withMarker = ('(?m)^' + [regex]::Escape($MARKER) + '\r?\n' + $tail)
  $result = $null
  if ($text -match $withMarker) {
    $result = ($text -replace $withMarker, '')
  } else {
    $bare = ('(?m)^' + $tail)
    if ($text -match $bare) { $result = ($text -replace $bare, '') }
  }
  if ($result -eq $null) { return $null }
  # The loader demands a top-level YAML array in this file. Removing our row from a
  # factory-state profile leaves the template comments with nothing after them, which
  # parses to undefined and the profile then refuses to start with
  #   "overlay ... must be a top-level YAML array of loader patch entries".
  # So when the removal leaves no content line behind, put the bare "[]" back: on a
  # factory-state profile this restores the original bytes exactly.
  if ((Get-LastContentLine $result) -eq $null) {
    $eol = if ($result.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lead = if ($result.Length -eq 0 -or $result.EndsWith($eol)) { '' } else { $eol }
    $result = ($result + $lead + '[]' + $eol)
  }
  return $result
}

# ------------------------------------------------------- bundle layer (startup layer)
function Test-BundleRow([string]$text) {
  return [bool]($text -match ('"' + [regex]::Escape($PLUGIN) + '"'))
}

function Add-BundleRow([string]$text) {
  if (Test-BundleRow $text) { return $null }
  $m = [regex]::Match($text, '(?s)("bundles"\s*:\s*\[)(.*?)(\s*\])')
  if (-not $m.Success) { throw 'package.json: dsh.profile.bundles array not found' }
  $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $inner = $m.Groups[2].Value.TrimEnd()
  if (-not $inner.EndsWith(',')) { $inner = $inner + ',' }
  $inner = $inner + $eol + '        "' + $PLUGIN + '"'
  return ($text.Substring(0, $m.Index) + $m.Groups[1].Value + $inner + $m.Groups[3].Value + $text.Substring($m.Index + $m.Length))
}

function Remove-BundleRow([string]$text) {
  $pattern = ',\s*"' + [regex]::Escape($PLUGIN) + '"(?=\s*\])'
  if ($text -notmatch $pattern) { return $null }
  return ($text -replace $pattern, '')
}

# ------------------------------------------------------------------- junction helpers
function Get-LinkTarget([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  $item = Get-Item $path -Force
  if ($item.LinkType -ne $null -and $item.Target -ne $null) { return (@($item.Target)[0]) }
  return '<real directory>'
}

function Test-LinkMatches([string]$target, [string]$wanted) {
  if ($target -eq $null) { return $false }
  return ($target -ieq $wanted -or $target.Replace('/', '\') -ieq $wanted)
}

function New-Junction([string]$link, [string]$target) {
  if (Test-Path $link) {
    $existing = Get-LinkTarget $link
    if (Test-LinkMatches $existing $target) { return 'exists' }
    throw ("$link already exists and points at $existing")
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  return 'created'
}

# ---------------------------------------------------------------- validation helpers
function Get-TextTail([string]$text, [int]$maxChars) {
  $trimmed = $text.TrimEnd()
  if ($trimmed.Length -le $maxChars) { return $trimmed }
  return ('...' + $trimmed.Substring($trimmed.Length - $maxChars))
}

# Structural net for the patch file: the factory template ends with a bare "[]" (an empty
# patch array); anything after that line is a second top-level node in the same YAML
# document and the loader rejects the whole file. Returns an error string, or $null when
# the structure is fine.
function Test-PatchStructure([string]$text) {
  $sawBareEmpty = $false
  foreach ($m in [regex]::Matches($text, '[^\r\n]+')) {
    $line = $m.Value.Trim()
    if ($line.StartsWith('#')) { continue }
    if ($line -eq '[]') { $sawBareEmpty = $true; continue }
    if ($sawBareEmpty) {
      return 'a bare "[]" line is followed by more content (two top-level YAML nodes)'
    }
  }
  return $null
}

# Parse the patch file with the YAML parser shipped inside the DSH install (yaml /
# js-yaml) and assert the one rule the loader enforces: the document must be a top-level
# ARRAY. A file that is empty or comments-only parses to undefined and the profile then
# dies with "overlay ... must be a top-level YAML array of loader patch entries".
# Returns $null when the file satisfies the loader, an error string when it does not, and
# the literal 'unavailable' when no parser can be located next to the dsh entry point.
function Test-PatchYamlWithNode([string]$path) {
  $dshRoot = Split-Path -Parent (Split-Path -Parent $DshBin)
  if (-not (Test-Path $dshRoot)) { return 'unavailable' }
  $hasYaml = (Test-Path (Join-Path $dshRoot 'node_modules\yaml')) -or (Test-Path (Join-Path $dshRoot 'node_modules\js-yaml'))
  if (-not $hasYaml) { return 'unavailable' }
  # Single quotes only: PowerShell 5.1 mangles embedded double quotes when it builds the
  # native command line for node.
  $script = 'const fs=require(''fs'');const p=process.argv[1];let y=null;try{y=require(''yaml'')}catch(e){try{y=require(''js-yaml'')}catch(e2){y=null}}if(!y){process.exit(0)}const src=fs.readFileSync(p,''utf8'');try{const v=(typeof y.parse===''function'')?y.parse(src):y.load(src);if(!Array.isArray(v)){console.error(''the file does not parse to a top-level array (got ''+(v===null||v===undefined?String(v):typeof v)+'')'');process.exit(3)}}catch(err){console.error(String((err&&err.message)||err));process.exit(3)}'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location $dshRoot
    $out = (& node -e $script $path 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
  if ($code -eq 0) { return $null }
  $detail = Get-TextTail $out 400
  if ($detail.Length -eq 0) { $detail = '(the YAML parser exited with ' + $code + ')' }
  return $detail
}

# Self-check of the patch file, run even when the compose check is skipped: skipping the
# compose check must never be able to leave a broken patch file on disk. Checks structure,
# then the real parse, and does NOT care whether our row is in there (the uninstall path
# needs exactly that).
function Test-PatchArray([string]$path) {
  $read = Get-Text $path
  $structural = Test-PatchStructure $read.text
  if ($structural -ne $null) {
    return [pscustomobject]@{ ok = $false; how = 'structure'; detail = $structural }
  }
  $parsed = Test-PatchYamlWithNode $path
  if ($parsed -eq 'unavailable') {
    return [pscustomobject]@{ ok = $true; how = 'structure only (no YAML parser found next to the dsh entry point)'; detail = '' }
  }
  if ($parsed -ne $null) {
    return [pscustomobject]@{ ok = $false; how = 'yaml parse'; detail = $parsed }
  }
  return [pscustomobject]@{ ok = $true; how = 'structure + yaml array parse'; detail = '' }
}

# Install-time variant: the same checks plus "our row is present".
function Test-PatchYaml([string]$path) {
  $read = Get-Text $path
  $structural = Test-PatchStructure $read.text
  if ($structural -ne $null) {
    return [pscustomobject]@{ ok = $false; how = 'structure'; detail = $structural }
  }
  if (-not (Test-UserPatchRow $read.text)) {
    return [pscustomobject]@{ ok = $false; how = 'structure'; detail = 'the plugin row is not present in the patch file' }
  }
  return Test-PatchArray $path
}

# ---------------------------------------------------------------- compose (read-only)
function Invoke-DumpConfig {
  if (-not (Test-Path $DshBin)) { throw ('dsh entry point not found: ' + $DshBin) }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = (& node $DshBin --profile $ProfileName --dump-config 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  [pscustomobject]@{ exitCode = $code; text = $output }
}

function Test-Compose {
  $dump = Invoke-DumpConfig
  # The dump text carries the real reason (a YAMLException, a bundle that will not
  # resolve, ...). Always quote its tail, otherwise the only visible message is
  # "dump-config exited with 1" and nobody can tell what broke.
  $tail = Get-TextTail $dump.text 800
  if ($dump.exitCode -ne 0) {
    throw ('dump-config exited with ' + $dump.exitCode + '. Last output:' + "`n" + $tail)
  }
  $hasRowId = [bool]($dump.text -match ('(?m)^\s*- id: ' + [regex]::Escape($ROW_ID) + '\s*$'))
  $hasName = [bool]($dump.text -match [regex]::Escape($PLUGIN))
  if (-not ($hasRowId -and $hasName)) {
    throw ('dump-config does not show the plugin row (id=' + $ROW_ID + ' name=' + $PLUGIN + '). Last output:' + "`n" + $tail)
  }
  return $dump.text
}

# ---------------------------------------------------------------- status
if ($Status) {
  Head ($PLUGIN + ' wiring status')
  Info ('package  : ' + $PackageDir)
  Info ('profile  : ' + $ProfileDir)
  $target = Get-LinkTarget $LINK
  Info ('junction : ' + $LINK)
  Info ('           -> ' + $(if ($target -eq $null) { '<missing>' } else { $target }))
  if (Test-Path $MANIFEST) {
    $read = Get-Text $MANIFEST
    $bundles = Test-BundleRow $read.text
    Info ('bundles  : ' + $(if ($bundles) { 'CONTAINS ' + $PLUGIN + ' (takes effect after a dsh web restart)' } else { 'not listed' }))
    Info ('json     : ' + $(if (Test-Json $read.text) { 'parses' } else { 'DOES NOT PARSE' }))
  } else {
    Info ('bundles  : <missing manifest: ' + $MANIFEST + '>')
  }
  if (Test-Path $PATCHFILE) {
    $patch = Get-Text $PATCHFILE
    $row = Test-UserPatchRow $patch.text
    Info ('userpatch: ' + $(if ($row) { 'CONTAINS the plugin row (live layer, no restart expected)' } else { 'no plugin row' }))
  } else {
    Info ('userpatch: <missing file: ' + $PATCHFILE + '>')
  }
  exit 0
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  Head ($PLUGIN + ' uninstall')
  $plan = New-Object System.Collections.ArrayList
  [void]$plan.Add('1. remove the plugin row from the user patch layer: ' + $PATCHFILE)
  [void]$plan.Add('2. remove "' + $PLUGIN + '" from dsh.profile.bundles (if present): ' + $MANIFEST)
  [void]$plan.Add('3. delete the junction: ' + $LINK)
  [void]$plan.Add('order matters: rows first (the live layer unloads at once), link last.')
  [void]$plan.Add('the edited patch file is re-checked: it must still parse to a top-level')
  [void]$plan.Add('YAML array. A file left empty or comments-only would stop the profile from')
  [void]$plan.Add('starting, so the bare "[]" is restored in that case (factory state = bytes back).')

  if ($DryRun) {
    Write-Host ''
    Write-Host '[dry-run] nothing was changed. -Uninstall would do:'
    foreach ($line in $plan) { Info $line }
    Info ('backups written next to the edited files as <name>.bak-<timestamp>-lightout')
    exit 0
  }

  $changed = $false

  if (Test-Path $PATCHFILE) {
    $read = Get-Text $PATCHFILE
    $updated = Remove-UserPatchRow $read.text
    if ($updated -eq $null) {
      Info 'user patch layer has no plugin row, skipped'
    } else {
      $backup = New-BackupName $PATCHFILE
      [IO.File]::WriteAllBytes($backup, $read.bytes)
      Ok ('backed up ' + $backup)
      Save-Text $PATCHFILE $updated $read.bom
      $verify = Get-Text $PATCHFILE
      if ($verify.text -ne $updated) {
        [IO.File]::WriteAllBytes($PATCHFILE, $read.bytes)
        Fail 'rolled back: the written patch file did not match the intended content'
      }
      # Removing the row must never leave a file the loader rejects. An empty or
      # comments-only patch file parses to undefined and the profile then refuses to start
      # ("overlay ... must be a top-level YAML array of loader patch entries"), so the
      # result is checked here and restored on the spot if it is not a valid array.
      $check = Test-PatchArray $PATCHFILE
      if (-not $check.ok) {
        [IO.File]::WriteAllBytes($PATCHFILE, $read.bytes)
        Fail ('rolled back: the patch file would no longer be valid (' + $check.how + '): ' + $check.detail)
      }
      Ok ('removed the plugin row from ' + $PATCHFILE)
      Ok ('patch file YAML self-check passed (' + $check.how + ')')
      $changed = $true
    }
  }

  if (Test-Path $MANIFEST) {
    $read = Get-Text $MANIFEST
    $updated = Remove-BundleRow $read.text
    if ($updated -eq $null) {
      Info 'dsh.profile.bundles has no plugin entry, skipped'
    } elseif (-not (Test-Json $updated)) {
      Fail 'refusing to write: package.json would no longer parse'
    } else {
      $backup = New-BackupName $MANIFEST
      [IO.File]::WriteAllBytes($backup, $read.bytes)
      Ok ('backed up ' + $backup)
      Save-Text $MANIFEST $updated $read.bom
      Ok ('removed the bundles entry from ' + $MANIFEST)
      $changed = $true
    }
  }

  if (Test-Path $LINK) {
    (Get-Item $LINK -Force).Delete()
    Ok ('deleted junction ' + $LINK)
    $changed = $true
  } else {
    Info 'junction is absent, skipped'
  }

  Write-Host ''
  if ($changed) {
    Warn 'if the junction was showing up through dsh.profile.bundles, a dsh web restart is'
    Warn 'needed for that layer to be re-read; the user patch layer unloads immediately.'
    Info 'rollback of the file edits: copy the newest *.bak-*-lightout files back over.'
  } else {
    Info 'nothing was installed, nothing to remove.'
  }
  exit 0
}

# ---------------------------------------------------------------- install
if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { Fail ('plugin package not found: ' + $PackageDir) }
if (-not (Test-Path (Join-Path $ProfileDir 'node_modules'))) { Fail ('profile has no node_modules: ' + $ProfileDir) }

$packageManifest = Get-Text (Join-Path $PackageDir 'package.json')
if (-not (Test-Json $packageManifest.text)) { Fail ('plugin package.json does not parse: ' + $PackageDir) }
if (-not $Bundles) {
  # nothing else to validate for the user patch layer
} elseif (-not (Test-Path $MANIFEST)) {
  Fail ('profile manifest not found: ' + $MANIFEST)
}

$originalManifest = $null
$updatedManifest = $null
if (Test-Path $MANIFEST) {
  $originalManifest = Get-Text $MANIFEST
  if (-not (Test-Json $originalManifest.text)) { Fail ('refusing to edit: package.json does not parse: ' + $MANIFEST) }
  if ($Bundles) {
    $updatedManifest = Add-BundleRow $originalManifest.text
    if ($updatedManifest -ne $null -and -not (Test-Json $updatedManifest)) { Fail 'refusing to write: package.json would no longer parse' }
  }
}

$patchExists = Test-Path $PATCHFILE
$originalPatch = if ($patchExists) { Get-Text $PATCHFILE } else { $null }
$patchText = if ($patchExists) { $originalPatch.text } else { '' }
$hasUserRow = Test-UserPatchRow $patchText
$hasBundleRow = if ($originalManifest -ne $null) { Test-BundleRow $originalManifest.text } else { $false }

$writeUserRow = $false
$writeBundleRow = $false
if ($Bundles) {
  if ($hasUserRow) {
    Fail ('the user patch layer already inserts row id "' + $ROW_ID + '" in ' + $PATCHFILE + '; drop -Bundles or run -Uninstall first (two layers must not insert the same row)')
  }
  $writeBundleRow = ($updatedManifest -ne $null)
} else {
  if ($hasBundleRow) {
    Warn ('dsh.profile.bundles already lists ' + $PLUGIN + '; leaving the user patch layer alone (a restart is what that path needs)')
  } else {
    $writeUserRow = -not $hasUserRow
  }
}

$linkTarget = Get-LinkTarget $LINK
$linkState = if ($linkTarget -eq $null) { 'will be created' } elseif (Test-LinkMatches $linkTarget $PackageDir) { 'already points at the package' } else { 'POINTS SOMEWHERE ELSE: ' + $linkTarget }
if ($linkTarget -ne $null -and -not (Test-LinkMatches $linkTarget $PackageDir)) {
  Fail ($LINK + ' already exists and points at ' + $linkTarget + ' (remove it yourself, this script will not clobber it)')
}

Head ($PLUGIN + ' install plan')
Info ('package  : ' + $PackageDir)
Info ('profile  : ' + $ProfileDir)
Info ('path     : ' + $(if ($Bundles) { 'bundle layer (dsh.profile.bundles) -- REQUIRES A DSH WEB RESTART' } else { 'user patch layer (cordis.patch.yml) -- live, no restart' }))
Info ('junction : ' + $LINK + '  [' + $linkState + ']')
if ($Bundles) {
  Info ('bundles  : ' + $MANIFEST + '  [' + $(if ($writeBundleRow) { 'one line to append' } elseif ($hasBundleRow) { 'already present' } else { 'n/a' }) + ']')
} else {
  Info ('userpatch: ' + $PATCHFILE + '  [' + $(if ($writeUserRow) { 'append one row block' } elseif ($hasUserRow) { 'row already present' } else { 'n/a' }) + ']')
}
if ($writeUserRow) {
  Info 'block to append:'
  foreach ($line in (Get-RowBlock "`n").Split("`n")) { Info ('          ' + $line) }
  $lastContent = if ($patchExists) { Get-LastContentLine $patchText } else { $null }
  if ($lastContent -ne $null -and $lastContent.Value.Trim() -eq '[]') {
    Info 'the target file is in factory state (ends with a bare "[]"):'
    Info 'that line is REPLACED by the block above, not appended to (appending would make'
    Info 'two top-level YAML nodes and the profile would fail to start).'
  }
}
if (-not $SkipComposeCheck) {
  Info ('compose  : node ' + $DshBin + ' --profile ' + $ProfileName + ' --dump-config')
  Info '           (a separate short-lived process; it never touches a running dsh web)'
} else {
  Info 'compose  : skipped by -SkipComposeCheck'
  Info '           (the patch file is still checked for YAML validity before the run ends)'
}

# The compose check resolves the profile BY NAME from DSH_HOME, not from -ProfileDir.
# Say so loudly instead of letting a custom -ProfileDir produce a confusing result.
$standardProfileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $ProfileName
if (-not $SkipComposeCheck -and -not ($ProfileDir -ieq $standardProfileDir)) {
  Warn ('custom -ProfileDir: the compose check still composes profile "' + $ProfileName + '" from DSH_HOME')
  Warn ('set DSH_HOME for an isolated run, or pass -SkipComposeCheck')
}

if ($DryRun) {
  Write-Host ''
  Write-Host '[dry-run] nothing was changed. Backups are written next to the edited files as'
  Write-Host '          <name>.bak-<timestamp>-lightout, and a failed compose check rolls back'
  Write-Host '          both the row and the junction.'
  exit 0
}

$createdLink = $false
$wrotePatch = $false
$wroteManifest = $false

try {
  $junctionState = New-Junction $LINK $PackageDir
  $createdLink = ($junctionState -eq 'created')
  Ok ('junction ' + $junctionState)

  if ($writeUserRow) {
    if ($patchExists) {
      $backup = New-BackupName $PATCHFILE
      [IO.File]::WriteAllBytes($backup, $originalPatch.bytes)
      Ok ('backed up ' + $backup)
    }
    $next = Add-UserPatchRow $patchText
    if ($next -eq $null) { throw 'internal error: patch row was expected to be added' }
    Save-Text $PATCHFILE $next $(if ($patchExists) { $originalPatch.bom } else { $false })
    $wrotePatch = $true
    $verify = Get-Text $PATCHFILE
    if ($verify.text -ne $next) { throw 'written file does not match the intended content' }
    Ok ('user patch layer updated: ' + $PATCHFILE)

    # Always re-read the written file and prove it is still valid YAML. This runs even
    # with -SkipComposeCheck, so skipping the compose check can never leave a broken
    # patch file behind (the factory-state "[]" bug could, before this check existed).
    $check = Test-PatchYaml $PATCHFILE
    if (-not $check.ok) {
      throw ('the written patch file is not valid YAML (' + $check.how + '): ' + $check.detail)
    }
    Ok ('patch file YAML self-check passed (' + $check.how + ')')
  } elseif ($hasUserRow) {
    Info 'user patch layer already had the row, file untouched'
    $check = Test-PatchYaml $PATCHFILE
    if (-not $check.ok) {
      throw ('the existing patch file is not valid YAML (' + $check.how + '): ' + $check.detail)
    }
    Ok ('patch file YAML self-check passed (' + $check.how + ')')
  }

  if ($writeBundleRow) {
    $backup = New-BackupName $MANIFEST
    [IO.File]::WriteAllBytes($backup, $originalManifest.bytes)
    Ok ('backed up ' + $backup)
    Save-Text $MANIFEST $updatedManifest $originalManifest.bom
    $wroteManifest = $true
    $verify = Get-Text $MANIFEST
    if ($verify.text -ne $updatedManifest) { throw 'written file does not match the intended content' }
    Ok ('dsh.profile.bundles updated: ' + $MANIFEST)
  }

  if ($SkipComposeCheck) {
    Info 'compose check skipped by -SkipComposeCheck'
  } else {
    $null = Test-Compose
    Ok ('compose check passed: the composed tree contains id=' + $ROW_ID + ' / name=' + $PLUGIN)
  }
} catch {
  Write-Host ("[x] " + $_.Exception.Message) -ForegroundColor Red
  Warn 'rolling back...'
  if ($wroteManifest -and $originalManifest -ne $null) { [IO.File]::WriteAllBytes($MANIFEST, $originalManifest.bytes) }
  if ($wrotePatch) {
    if ($patchExists) { [IO.File]::WriteAllBytes($PATCHFILE, $originalPatch.bytes) } else { Remove-Item -LiteralPath $PATCHFILE -Force }
  }
  if ($createdLink -and (Test-Path $LINK)) { (Get-Item $LINK -Force).Delete() }
  Warn 'rolled back to the pre-change state.'
  exit 1
}

Write-Host ''
if ($Bundles) {
  Warn 'RESTART REQUIRED: dsh.profile.bundles is read once at startup, so the user has to'
  Warn 'restart dsh web (an agent must not restart the host it runs inside).'
} else {
  Ok 'the row lives in the live user patch layer: the host half mounts without a restart.'
  Info 'If GET /api/dsh-lightout/status still answers 404 after a few seconds, the live'
  Info 'reload did not pick it up -- then the user restarts dsh web as a fallback.'
}
Write-Host 'REFRESH REQUIRED: the browser half is delivered per page load, so press Ctrl+Shift+R.'
Write-Host ''
Write-Host 'self check (read-only):'
Info ('powershell -NoProfile -File "' + (Join-Path $scriptDir 'install-lightout.ps1') + '" -Status')
Info ('curl.exe http://127.0.0.1:3080/api/dsh-lightout/status')
Write-Host 'uninstall:'
Info ('powershell -NoProfile -File "' + (Join-Path $scriptDir 'install-lightout.ps1') + '" -Uninstall -DryRun')
Info 'drop -DryRun to actually remove it (rows first, junction last).'
