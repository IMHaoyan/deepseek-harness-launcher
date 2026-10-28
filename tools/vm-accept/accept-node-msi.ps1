# accept-node-msi.ps1 - runs INSIDE Windows Sandbox (or any disposable Windows VM).
#
# Purpose: end-to-end acceptance of the official Node MSI install path used by DSHL.
#
# Phase A (main path, bundled Node 24.22.1):
#   installs the bundled official MSI machine-wide, asserts the full MSI footprint (the
#   "identical to nodejs.org .msi" checklist), asserts DSHL's own decision/registry code
#   against the real machine, then uninstalls and asserts the machine is clean again.
#
# Phase B (major upgrade, official 22.23.2 -> bundled 24.22.1):
#   downloads the official Node 22.23.2 MSI, verifies its official sha256, silently installs
#   it, installs a small global npm package under %APPDATA%\npm, then installs the bundled
#   24.22.1 MSI DIRECTLY over it (no manual uninstall - official Node MSIs carry a WiX major
#   upgrade: same UpgradeCode + RemoveExistingProducts). Asserts the old product is removed,
#   exactly one Apps&Features entry remains at 24.22.1, and the global package survived and
#   is still callable. Finally uninstalls 24.22.1 and asserts the machine is clean again.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI, so non-ASCII
# here would be mangled. Keep this file ASCII-only and WITHOUT BOM. Chinese documentation lives
# in tools/vm-accept/README.md (host side).
#
# STATUS: verified in Windows Sandbox on 2026-10-28 (57/57 PASS): bundled Node 24.22.1 install path
# plus the real 22.23.2 -> 24.22.1 major upgrade. Re-run this script before every release that
# changes the bundled Node MSI; do not claim acceptance from an older run.
#
# Usage (host launches this through WindowsSandbox.wsb):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File accept-node-msi.ps1 `
#       -Repo 'C:\vm\repo' -Out 'C:\vm\out' -ExpectedSha256 '<hash>' [-InstallDsh] [-KeepRunning]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ExpectedSha256 = '',
  [switch]$InstallDsh,   # also install the real @deepseek-ai/dsh and prove globals land in %APPDATA%\npm
  [switch]$KeepRunning   # do not shut the VM down at the end (for manual inspection)
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Expected identities (verified against the bundled MSI files with msi-inspect.ps1)
# ---------------------------------------------------------------------------
# Bundled (new) official Node MSI shipped by DSHL:
$expectedVersion = '24.22.1'
$expectedProductCode = '{C4336CDB-0C40-48B8-9FB2-2333D58EC5C5}'
# Old official Node MSI used only by the 22 -> 24 major-upgrade phase:
$oldVersion = '22.23.2'
$oldProductCode = '{D9606E8F-44C3-4F42-9165-0F62294FDD4B}'
$oldSha256 = 'ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989'
$oldMsiName = 'node-v22.23.2-x64.msi'
$oldMsiUrls = @(
  ('https://npmmirror.com/dist/v' + $oldVersion + '/node-v' + $oldVersion + '-x64.msi'),
  ('https://nodejs.org/dist/v' + $oldVersion + '/node-v' + $oldVersion + '-x64.msi')
)
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$npmCmd = 'C:\Program Files\nodejs\npm.cmd'
$uninstallKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

$results = New-Object System.Collections.ArrayList
function A([string]$name, [bool]$ok, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail })
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1} :: {2}" -f $tag, $name, $detail)
}
function Step([string]$msg) { Write-Host ''; Write-Host ("=== " + $msg + " ===") }
function Get-Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower() }
function Get-NodeJsEntries {
  @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Node.js' })
}
# MSI only edits the registry PATH; the process that installed it keeps its stale environment.
# Rebuild PATH from the registry so later assertions test what a NEW shell/logon would get.
function Refresh-PathFromRegistry {
  $machinePathNow = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
  $userPathNow = ''
  try { $userPathNow = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
  $env:PATH = [Environment]::ExpandEnvironmentVariables($machinePathNow) + ';' + [Environment]::ExpandEnvironmentVariables($userPathNow)
}
function Save-RemoteFile([string]$url, [string]$dest) {
  Write-Host ('  downloading ' + $url)
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 300
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
# Drop a "we actually started" marker first: the host uses it to tell "sandbox did not start /
# LogonCommand did not run" apart from "script is stuck somewhere".
$startedMark = Join-Path $Out 'vm-started.txt'
try { ("started {0} host={1} user={2}" -f (Get-Date -Format s), $env:COMPUTERNAME, $env:USERNAME) | Set-Content -Path $startedMark -Encoding UTF8 } catch { }
$log = Join-Path $Out 'vm-accept-transcript.txt'
try { Start-Transcript -Path $log -Force | Out-Null } catch { }

# The expected hash can be dropped into the mapped folder by the host runner (avoids hardcoding
# it in the .wsb).
if (-not $ExpectedSha256) {
  $hashFile = Join-Path $Out 'expected-sha256.txt'
  if (Test-Path $hashFile) { $ExpectedSha256 = ((Get-Content $hashFile -Raw).Trim() -split '\s+')[0] }
}

# Sandbox UAC behavior is uncertain: if we do not hold a high-integrity token, relaunch ourselves
# via RunAs (silently succeeds when UAC is off).
$isAdminNow = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdminNow) {
  Write-Host 'Not elevated -> relaunching elevated...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Repo', $Repo, '-Out', $Out) +
    $(if ($ExpectedSha256) { @('-ExpectedSha256', $ExpectedSha256) }) +
    $(if ($InstallDsh) { @('-InstallDsh') }) + $(if ($KeepRunning) { @('-KeepRunning') })
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList $argList
  exit
}

Step 'environment'
$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("OS: {0} build {1} {2}" -f $os.Caption, $os.BuildNumber, $os.OSArchitecture)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
A 'vm/admin-token' $isAdmin ("IsInRole(Administrator)=" + $isAdmin)

Step 'resolve the bundled MSI'
$msi = Get-ChildItem -Path (Join-Path $Repo 'assets\node-dist') -Filter 'node-v*-x64.msi' -ErrorAction SilentlyContinue |
  Sort-Object Name | Select-Object -Last 1
if (-not $msi) {
  A 'msi/present' $false ('no node-v*-x64.msi under ' + (Join-Path $Repo 'assets\node-dist'))
  $msi = $null
} else {
  $sha = (Get-FileHash -Algorithm SHA256 -Path $msi.FullName).Hash.ToLower()
  $sidecar = ''
  if (Test-Path ($msi.FullName + '.sha256')) { $sidecar = ((Get-Content ($msi.FullName + '.sha256') -Raw).Trim() -split '\s+')[0].ToLower() }
  A 'msi/present' $true ($msi.Name + '  ' + [math]::Round($msi.Length / 1MB, 1) + ' MB (expected v' + $expectedVersion + ')')
  A 'msi/sha256-sidecar-matches' ($sidecar -eq '' -or $sidecar -eq $sha) ('file=' + $sha.Substring(0, 16) + '... sidecar=' + $(if ($sidecar) { $sidecar.Substring(0, 16) + '...' } else { '(none)' }))
  if ($ExpectedSha256) { A 'msi/sha256-official' ($sha -eq $ExpectedSha256.ToLower()) ('expected=' + $ExpectedSha256.Substring(0, 16) + '...') }
}

Step 'precondition: no Node.js MSI product yet'
$preMsi = $null
try { $preMsi = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
A 'precondition/no-existing-node-msi' ($null -eq $preMsi) $(if ($preMsi) { 'found v' + $preMsi.Version + ' at ' + $preMsi.InstallPath } else { 'HKLM\SOFTWARE\Node.js absent (clean VM)' })

if ($msi -and -not $preMsi) {
  Step 'install: msiexec /i <official msi> /qn /norestart'
  $msiLog = Join-Path $Out 'msi-install.log'
  $work = Join-Path $env:TEMP $msi.Name
  Copy-Item $msi.FullName $work -Force
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $work, '/qn', '/norestart', '/l*v', $msiLog) -Wait -PassThru
  $code = $p.ExitCode
  # 1730/1925 = insufficient privileges (sandbox UAC is uncertain) -> retry through RunAs
  if ($code -eq 1730 -or $code -eq 1925) {
    Write-Host ('msiexec exit ' + $code + ' (needs elevation) -> retrying via RunAs')
    $p2 = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', $work, '/qn', '/norestart', '/l*v', $msiLog) -Wait -PassThru
    $code = $p2.ExitCode
  }
  A 'install/exit-code' ($code -eq 0 -or $code -eq 3010) ('msiexec exit ' + $code + ' (0/3010 = success)')
  Remove-Item $work -Force -ErrorAction SilentlyContinue

  Step 'refresh this session PATH from the registry (== what a NEW shell/logon inherits)'
  Refresh-PathFromRegistry
  A 'env/refreshed-from-registry' ($env:PATH -like '*Program Files\nodejs*') ('PATH rebuilt from registry, ' + $env:PATH.Length + ' chars')

  Step 'footprint 1/7: files land in C:\Program Files\nodejs'
  A 'footprint/program-files-node.exe' (Test-Path $nodeExe) $nodeExe
  if (Test-Path $nodeExe) {
    $ver = (& $nodeExe -v) 2>$null
    A 'footprint/node-version' ($ver -eq ('v' + $expectedVersion)) ('node -v = ' + $ver)
  }

  Step 'footprint 2/7: HKLM\SOFTWARE\Node.js (InstallPath + Version)'
  $reg = $null
  try { $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
  A 'footprint/hklm-nodejs' ($null -ne $reg) $(if ($reg) { 'InstallPath=' + $reg.InstallPath + ' Version=' + $reg.Version } else { 'missing' })

  Step 'footprint 3/7: machine PATH gets the install dir'
  $machinePath = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
  A 'footprint/machine-path' ($machinePath -like '*Program Files\nodejs*') ($machinePath.Substring(0, [Math]::Min(160, $machinePath.Length)) + '...')

  Step 'footprint 4/7: user PATH gets %APPDATA%\npm (globals must be callable)'
  $userPath = ''
  try { $userPath = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
  $expanded = [Environment]::ExpandEnvironmentVariables($userPath)
  A 'footprint/user-path-appdata-npm' ($userPath -like '*npm*' -and $expanded -like '*\AppData\Roaming\npm*') ('raw=' + $userPath)

  Step 'footprint 5/7: registered in Apps & Features'
  $entry = Get-NodeJsEntries | Select-Object -First 1
  A 'footprint/apps-and-features' ($null -ne $entry -and $entry.DisplayVersion -eq $expectedVersion) `
    $(if ($entry) { 'DisplayName=' + $entry.DisplayName + ' DisplayVersion=' + $entry.DisplayVersion + ' Uninstall=' + $entry.UninstallString } else { 'no Node.js uninstall entry' })

  Step 'footprint 6/7: Start Menu folder (all users)'
  $sm = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Node.js'
  $smItems = @()
  if (Test-Path $sm) { $smItems = Get-ChildItem $sm | Select-Object -ExpandProperty Name }
  A 'footprint/start-menu' ($smItems.Count -ge 4) ($smItems -join ' | ')

  Step 'footprint 7/7: the 23-byte npmrc (this is what fixes the npm global root)'
  $npmrc = 'C:\Program Files\nodejs\node_modules\npm\npmrc'
  if (Test-Path $npmrc) {
    $bytes = [System.IO.File]::ReadAllBytes($npmrc)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    A 'footprint/npmrc-bytes' ($bytes.Length -eq 23 -and $text -eq "prefix=`${APPDATA}\npm`r`n") ('len=' + $bytes.Length + ' text=' + ($text -replace "`r`n", '\r\n'))
  } else {
    A 'footprint/npmrc-bytes' $false ($npmrc + ' missing -> npm global root would stay inside Program Files')
  }

  Step 'semantics: npm global root and where globals land'
  $prefix = ''
  if (Test-Path $npmCmd) { $prefix = (& $npmCmd config get prefix) 2>$null }
  $expectedPrefix = Join-Path $env:APPDATA 'npm'
  A 'semantics/npm-config-get-prefix' ($prefix -eq $expectedPrefix) ('prefix=' + $prefix + ' expected=' + $expectedPrefix)

  Step 'semantics: node/npm reachable from a FRESH process via machine PATH'
  $fresh = & cmd.exe /c 'node -v && npm -v' 2>$null
  $freshText = ($fresh -join ' ')
  A 'semantics/fresh-shell-node-npm' ($freshText -match ('v' + [regex]::Escape($expectedVersion))) ('node/npm via PATH: ' + $freshText)

  Step 'semantics: npm i -g lands under %APPDATA%\npm (tiny package)'
  $tiny = 'is-number'
  $npmOut = & $npmCmd install -g --no-audit --no-fund --loglevel=error $tiny 2>&1
  $tinyPkg = Join-Path $env:APPDATA ("npm\node_modules\" + $tiny + "\package.json")
  if (Test-Path $tinyPkg) {
    A 'semantics/global-install-location' $true ($tinyPkg)
    & $npmCmd uninstall -g $tiny --no-audit --no-fund --loglevel=error 2>&1 | Out-Null
  } else {
    A 'semantics/global-install-location' $false ('not found: ' + $tinyPkg + ' | npm said: ' + (($npmOut | Select-Object -Last 3) -join ' '))
  }

  if ($InstallDsh) {
    Step 'semantics: real DSH install goes to %APPDATA%\npm and dsh.cmd works'
    & $npmCmd install -g --no-audit --no-fund --loglevel=error '@deepseek-ai/dsh' 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host ('   npm: ' + $_) }
    $dshPkg = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'
    A 'semantics/dsh-location' (Test-Path $dshPkg) $dshPkg
    $dshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd'
    $dshVer = ''
    if (Test-Path $dshCmd) { $dshVer = (& cmd.exe /c ('"' + $dshCmd + '" --version')) 2>$null }
    A 'semantics/dsh-command' ($dshVer -match '^\d') ('dsh --version = ' + $dshVer)
  }

  Step 'DSHL code against the real machine (reuse / upgrade decisions)'
  $probe = @'
const path = require('path')
const envInstall = require(path.join(process.env.REPO, 'env-install.js'))
const envDetect = require(path.join(process.env.REPO, 'env-detect.js'))
;(async () => {
  const msi = await envInstall.readInstalledNodeMsi()
  const vm = envInstall.detectVersionManager()
  envDetect.initEnv({ realHome: path.join(process.env.USERPROFILE, '.dsh'), Config: { npmGlobalRoot: '' }, log: () => {} })
  const report = await envDetect.detectEnv(true)
  const s = envDetect.envSummary(report)
  const reuse = envInstall.decideNodeInstallPlan({ nodeOk: false, installedMsi: msi, versionManager: vm })
  const oldPlan = envInstall.decideNodeInstallPlan({ nodeOk: false, installedMsi: { version: '18.20.0' }, versionManager: vm })
  const live = envInstall.decideNodeInstallPlan({ nodeOk: s.node.status === 'ok', nodeVersion: s.node.version, installedMsi: msi, versionManager: vm })
  console.log(JSON.stringify({
    registryMsi: msi,
    versionManager: vm,
    detect: { node: s.node.status + '/' + s.node.version, nodeSource: s.node.source, dsh: s.dsh.status + '/' + s.dsh.kind, root: s.dsh.root, ready: s.ready, legacyNode: s.legacyNode },
    nodeUpgrade: s.nodeUpgrade,
    planWithInstalledMsi: reuse,
    planWithOldMsi: oldPlan,
    planLive: live,
  }, null, 2))
})().catch((e) => { console.log('PROBE-ERROR ' + (e && e.message)); process.exit(3) })
'@
  $probeFile = Join-Path $env:TEMP 'dshl-probe.js'
  Set-Content -Path $probeFile -Value $probe -Encoding ASCII
  $env:REPO = $Repo
  $probeOut = & $nodeExe $probeFile 2>&1
  $probeText = ($probeOut -join "`n")
  Write-Host $probeText
  Set-Content -Path (Join-Path $Out 'dshl-probe.json') -Value $probeText -Encoding UTF8
  try {
    $j = $probeText | ConvertFrom-Json
    A 'dshl/registry-reads-official-msi' ($j.registryMsi.version -eq $expectedVersion) ('version=' + $j.registryMsi.version + ' installPath=' + $j.registryMsi.installPath)
    A 'dshl/plan-reuses-installed-msi' ($j.planWithInstalledMsi.action -eq 'reuse') ('action=' + $j.planWithInstalledMsi.action + ' reason=' + $j.planWithInstalledMsi.reason)
    A 'dshl/plan-upgrades-older-msi' ($j.planWithOldMsi.action -eq 'upgrade-msi' -and $j.planWithOldMsi.reason -eq 'msi-too-old') ('action=' + $j.planWithOldMsi.action + ' reason=' + $j.planWithOldMsi.reason + ' from=' + $j.planWithOldMsi.from)
    A 'dshl/no-node-upgrade-hint-when-target-installed' ($null -eq $j.nodeUpgrade) ('nodeUpgrade=' + $(if ($null -eq $j.nodeUpgrade) { 'null' } else { ($j.nodeUpgrade | ConvertTo-Json -Compress) }))
    A 'dshl/detect-node-ok' ($j.detect.node -eq ('ok/' + $expectedVersion)) ('node=' + $j.detect.node + ' source=' + $j.detect.nodeSource)
  } catch {
    A 'dshl/probe-json' $false ('could not parse probe output: ' + $probeText.Substring(0, [Math]::Min(300, $probeText.Length)))
  }

  Step 'uninstall: msiexec /x {ProductCode} /qn (and prove nothing is left behind)'
  $unLog = Join-Path $Out 'msi-uninstall.log'
  $up = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $expectedProductCode, '/qn', '/norestart', '/l*v', $unLog) -Wait -PassThru
  A 'uninstall/exit-code' ($up.ExitCode -eq 0 -or $up.ExitCode -eq 3010) ('msiexec /x exit ' + $up.ExitCode)
  Start-Sleep -Seconds 2
  A 'uninstall/program-files-gone' (-not (Test-Path $nodeExe)) ('node.exe still there: ' + (Test-Path $nodeExe))
  $machinePath2 = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
  A 'uninstall/machine-path-clean' ($machinePath2 -notlike '*Program Files\nodejs*') 'PATH entry removed by the MSI'
  $userPath2 = ''
  try { $userPath2 = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
  A 'uninstall/user-path-clean' ($userPath2 -notlike '*npm*') ('raw=' + $userPath2)
  $entry2 = Get-NodeJsEntries | Select-Object -First 1
  A 'uninstall/apps-and-features-clean' ($null -eq $entry2) $(if ($entry2) { 'still registered' } else { 'not registered anymore' })

  # ===========================================================================
  # Phase B: official Node 22.23.2 -> bundled Node 24.22.1 major upgrade.
  # The machine is clean again after the uninstall above; start from zero.
  # ===========================================================================
  Step 'upgrade: obtain the official Node 22.23.2 MSI and verify its official sha256'
  $oldMsi = Join-Path $env:TEMP $oldMsiName
  Remove-Item $oldMsi -Force -ErrorAction SilentlyContinue
  $oldSha = ''
  $oldSource = ''
  foreach ($url in $oldMsiUrls) {
    try {
      Save-RemoteFile $url $oldMsi
      $oldSha = Get-Sha256 $oldMsi
      if ($oldSha -eq $oldSha256) { $oldSource = $url; break }
      Write-Host ('  sha256 mismatch from ' + $url + ': got ' + $oldSha + ', expected ' + $oldSha256 + '; trying next source')
    } catch {
      Write-Host ('  download failed from ' + $url + ': ' + $_.Exception.Message)
    }
  }
  # Last resort: the repo may still bundle the old official MSI (verified with the same sha256).
  if ($oldSha -ne $oldSha256) {
    $bundledOldMsi = Join-Path $Repo ('assets\node-dist\' + $oldMsiName)
    if (Test-Path $bundledOldMsi) {
      Copy-Item $bundledOldMsi $oldMsi -Force
      $oldSha = Get-Sha256 $oldMsi
      $oldSource = 'bundled copy in repo assets'
    }
  }
  $oldMsiOk = ($oldSha -eq $oldSha256)
  A 'upgrade/22-msi-official-sha256' $oldMsiOk (
    $(if ($oldSha) { 'sha256=' + $oldSha.Substring(0, 16) + '...' } else { 'sha256=(not obtained)' }) +
    ' expected=' + $oldSha256.Substring(0, 16) + '...' +
    $(if ($oldSource) { ' source=' + $oldSource } else { '' }))

  if (-not $oldMsiOk) {
    A 'upgrade/phase-completed' $false 'official Node 22.23.2 MSI unavailable or sha256 mismatch -> major-upgrade phase could not run'
  } else {
    Step 'upgrade: precondition - machine is clean again before installing 22.23.2'
    $preUp = $null
    try { $preUp = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
    $preEntries = @(Get-NodeJsEntries)
    $preClean = ($null -eq $preUp -and -not (Test-Path $nodeExe) -and $preEntries.Count -eq 0)
    A 'upgrade/precondition-clean' $preClean $(if ($preClean) { 'no Node.js MSI product, no install dir, no Apps&Features entry' } else { 'HKLM=' + $(if ($preUp) { 'v' + $preUp.Version } else { 'absent' }) + ' node.exe=' + (Test-Path $nodeExe) + ' apps-and-features-entries=' + $preEntries.Count })
    if (-not $preClean) {
      A 'upgrade/phase-skipped' $false 'machine is not clean -> major-upgrade phase skipped (fail-closed: no second Node product installed)'
    } else {

      Step 'upgrade: silent-install the official Node 22.23.2 MSI'
      $oldLog = Join-Path $Out 'upgrade-22-install.log'
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $oldMsi, '/qn', '/norestart', '/l*v', $oldLog) -Wait -PassThru
      $code = $p.ExitCode
      if ($code -eq 1730 -or $code -eq 1925) {
        Write-Host ('msiexec exit ' + $code + ' (needs elevation) -> retrying via RunAs')
        $p2 = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', $oldMsi, '/qn', '/norestart', '/l*v', $oldLog) -Wait -PassThru
        $code = $p2.ExitCode
      }
      A 'upgrade/22-install-exit-code' ($code -eq 0 -or $code -eq 3010) ('msiexec exit ' + $code + ' (0/3010 = success)')
      Start-Sleep -Seconds 2

      Refresh-PathFromRegistry
      A 'upgrade/22-path-from-registry' ($env:PATH -like '*Program Files\nodejs*') ('PATH rebuilt from registry, ' + $env:PATH.Length + ' chars')
      $ver22 = ''
      if (Test-Path $nodeExe) { $ver22 = (& $nodeExe -v) 2>$null }
      A 'upgrade/22-node-version' ($ver22 -eq ('v' + $oldVersion)) ('node -v = ' + $ver22)
      $reg22 = $null
      try { $reg22 = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
      A 'upgrade/22-hklm-version' ($null -ne $reg22 -and $reg22.Version -eq $oldVersion) $(if ($reg22) { 'Version=' + $reg22.Version + ' InstallPath=' + $reg22.InstallPath } else { 'HKLM\SOFTWARE\Node.js missing' })
      $entries22 = @(Get-NodeJsEntries)
      A 'upgrade/22-apps-and-features' ($entries22.Count -eq 1 -and $entries22[0].DisplayVersion -eq $oldVersion) ('count=' + $entries22.Count + ' DisplayVersion=' + $(if ($entries22.Count -gt 0) { $entries22[0].DisplayVersion } else { '(none)' }))
      $oldEntry22 = @($entries22 | Where-Object { $_.PSChildName -eq $oldProductCode })
      A 'upgrade/22-productcode-registered' ($oldEntry22.Count -eq 1) ('old ProductCode ' + $oldProductCode + ' -> ' + $oldEntry22.Count + ' entry/entries')

      Step 'upgrade: DSHL sees the installed 22.23.2 MSI as upgradeable (source of the in-app upgrade card)'
      # This is the only source of the in-app upgrade card: envSummary.nodeUpgrade must be derived from
      # real registry facts. Also assert both edges: an explicit upgrade request -> upgrade-msi, while the
      # normal install path (nodeOk=true) must still reuse (no silent upgrade).
      $upProbe = @'
const path = require('path')
const envDetect = require(path.join(process.env.REPO, 'env-detect.js'))
const envInstall = require(path.join(process.env.REPO, 'env-install.js'))
;(async () => {
  envDetect.initEnv({ realHome: path.join(process.env.USERPROFILE, '.dsh'), Config: { nodeMajor: 24, npmGlobalRoot: '' }, log: () => {} })
  const report = await envDetect.detectEnv(true)
  const s = envDetect.envSummary(report)
  const msi = await envInstall.readInstalledNodeMsi()
  const explicit = envInstall.decideNodeInstallPlan({ upgrade: true, installedMsi: msi })
  const normal = envInstall.decideNodeInstallPlan({ nodeOk: s.node.status === 'ok', nodeVersion: s.node.version, installedMsi: msi, versionManager: '' })
  console.log(JSON.stringify({
    node: s.node.status + '/' + s.node.version,
    nodeUpgrade: s.nodeUpgrade,
    explicitPlan: explicit,
    normalPlan: normal,
  }, null, 2))
})().catch((e) => { console.log('PROBE-ERROR ' + (e && e.message)); process.exit(3) })
'@
      $upProbeFile = Join-Path $env:TEMP 'dshl-probe-upgradeable.js'
      Set-Content -Path $upProbeFile -Value $upProbe -Encoding ASCII
      $env:REPO = $Repo
      $upProbeOut = & $nodeExe $upProbeFile 2>&1
      $upProbeText = ($upProbeOut -join "`n")
      Write-Host $upProbeText
      Set-Content -Path (Join-Path $Out 'dshl-probe-upgradeable.json') -Value $upProbeText -Encoding UTF8
      try {
        $uj = $upProbeText | ConvertFrom-Json
        A 'upgrade/dshl-detects-old-msi-as-upgradeable' ($null -ne $uj.nodeUpgrade -and $uj.nodeUpgrade.mode -eq 'msi' -and $uj.nodeUpgrade.from -eq $oldVersion -and $uj.nodeUpgrade.targetMajor -eq 24 -and $uj.nodeUpgrade.reason -eq 'msi-older-major') ('nodeUpgrade=' + $(if ($null -eq $uj.nodeUpgrade) { 'null' } else { ($uj.nodeUpgrade | ConvertTo-Json -Compress) }))
        A 'upgrade/dshl-explicit-plan-upgrade-msi' ($uj.explicitPlan.action -eq 'upgrade-msi' -and $uj.explicitPlan.from -eq $oldVersion) ('action=' + $uj.explicitPlan.action + ' from=' + $uj.explicitPlan.from)
        A 'upgrade/dshl-normal-plan-still-reuse' ($uj.normalPlan.action -eq 'reuse') ('action=' + $uj.normalPlan.action + ' reason=' + $uj.normalPlan.reason + ' (normal install path must not upgrade silently)')
      } catch {
        A 'upgrade/dshl-upgradeable-probe-json' $false ('could not parse probe output: ' + $upProbeText.Substring(0, [Math]::Min(300, $upProbeText.Length)))
      }

      Step 'upgrade: install a small global npm package under %APPDATA%\npm before upgrading'
      $globalPkg = 'semver'
      $globalPkgJson = Join-Path $env:APPDATA ('npm\node_modules\' + $globalPkg + '\package.json')
      $globalShim = Join-Path $env:APPDATA ('npm\' + $globalPkg + '.cmd')
      $globalBefore = $false
      if (Test-Path $npmCmd) {
        $npmOut = & $npmCmd install -g --no-audit --no-fund --loglevel=error $globalPkg 2>&1
        $globalBefore = Test-Path $globalPkgJson
        if (-not $globalBefore) { Write-Host ('  npm said: ' + (($npmOut | Select-Object -Last 3) -join ' ')) }
      }
      A 'upgrade/global-package-before' $globalBefore ('expected: ' + $globalPkgJson)
      A 'upgrade/global-shim-before' (Test-Path $globalShim) ('expected shim: ' + $globalShim)

      Step 'upgrade: install bundled Node 24.22.1 MSI directly over 22.23.2 (major upgrade, no manual uninstall of 22)'
      $upWork = Join-Path $env:TEMP $msi.Name
      Copy-Item $msi.FullName $upWork -Force
      $upLog = Join-Path $Out 'upgrade-24-install.log'
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $upWork, '/qn', '/norestart', '/l*v', $upLog) -Wait -PassThru
      $code = $p.ExitCode
      if ($code -eq 1730 -or $code -eq 1925) {
        Write-Host ('msiexec exit ' + $code + ' (needs elevation) -> retrying via RunAs')
        $p2 = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', $upWork, '/qn', '/norestart', '/l*v', $upLog) -Wait -PassThru
        $code = $p2.ExitCode
      }
      A 'upgrade/24-install-exit-code' ($code -eq 0 -or $code -eq 3010) ('msiexec exit ' + $code + ' (0/3010 = success)')
      Remove-Item $upWork -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3

      Refresh-PathFromRegistry
      A 'upgrade/24-path-from-registry' ($env:PATH -like '*Program Files\nodejs*') ('PATH rebuilt from registry, ' + $env:PATH.Length + ' chars')
      $ver24 = ''
      if (Test-Path $nodeExe) { $ver24 = (& $nodeExe -v) 2>$null }
      A 'upgrade/24-node-version' ($ver24 -eq ('v' + $expectedVersion)) ('node -v = ' + $ver24)
      $reg24 = $null
      try { $reg24 = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
      A 'upgrade/24-hklm-version' ($null -ne $reg24 -and $reg24.Version -eq $expectedVersion) $(if ($reg24) { 'Version=' + $reg24.Version + ' InstallPath=' + $reg24.InstallPath } else { 'HKLM\SOFTWARE\Node.js missing' })
      $entries24 = @(Get-NodeJsEntries)
      A 'upgrade/24-apps-and-features-single' ($entries24.Count -eq 1) ('count=' + $entries24.Count + ' versions=' + (($entries24 | ForEach-Object { $_.DisplayVersion }) -join ','))
      A 'upgrade/24-apps-and-features-version' ($entries24.Count -eq 1 -and $entries24[0].DisplayVersion -eq $expectedVersion) ('DisplayVersion=' + $(if ($entries24.Count -gt 0) { $entries24[0].DisplayVersion } else { '(none)' }))
      $oldLeft = @($entries24 | Where-Object { $_.PSChildName -eq $oldProductCode })
      A 'upgrade/old-productcode-unregistered' ($oldLeft.Count -eq 0) ('old ProductCode ' + $oldProductCode + ' -> ' + $oldLeft.Count + ' entry/entries')
      A 'upgrade/global-package-after' (Test-Path $globalPkgJson) ('still present: ' + (Test-Path $globalPkgJson) + ' (' + $globalPkgJson + ')')
      A 'upgrade/global-shim-after' (Test-Path $globalShim) ('still present: ' + (Test-Path $globalShim) + ' (' + $globalShim + ')')
      $shimOut = ''
      if (Test-Path $globalShim) {
        $shimOut = (& $globalShim '1.2.3' 2>$null)
        $shimOut = (($shimOut | Out-String).Trim())
      }
      A 'upgrade/global-shim-runs' ($shimOut -eq '1.2.3') ('semver 1.2.3 -> [' + $shimOut + ']')

      Step 'upgrade: uninstall Node 24.22.1 and prove the machine is clean again'
      $upUnLog = Join-Path $Out 'upgrade-24-uninstall.log'
      $up = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $expectedProductCode, '/qn', '/norestart', '/l*v', $upUnLog) -Wait -PassThru
      A 'upgrade/uninstall-exit-code' ($up.ExitCode -eq 0 -or $up.ExitCode -eq 3010) ('msiexec /x exit ' + $up.ExitCode)
      Start-Sleep -Seconds 2
      A 'upgrade/uninstall-program-files-gone' (-not (Test-Path $nodeExe)) ('node.exe still there: ' + (Test-Path $nodeExe))
      $machinePath3 = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
      A 'upgrade/uninstall-machine-path-clean' ($machinePath3 -notlike '*Program Files\nodejs*') 'PATH entry removed by the MSI'
      $userPath3 = ''
      try { $userPath3 = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
      A 'upgrade/uninstall-user-path-clean' ($userPath3 -notlike '*npm*') ('raw=' + $userPath3)
      $regAfter = $null
      try { $regAfter = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop } catch { }
      A 'upgrade/uninstall-hklm-registry-gone' ($null -eq $regAfter) $(if ($regAfter) { 'still registered: Version=' + $regAfter.Version } else { 'HKLM\SOFTWARE\Node.js removed' })
      $entriesAfter = @(Get-NodeJsEntries)
      A 'upgrade/uninstall-apps-and-features-gone' ($entriesAfter.Count -eq 0) ('Node.js entries left: ' + $entriesAfter.Count)
      Remove-Item $oldMsi -Force -ErrorAction SilentlyContinue
    }
  }
}

Step 'summary'
$pass = ($results | Where-Object { $_.ok }).Count
$fail = ($results | Where-Object { -not $_.ok }).Count
Write-Host ("TOTAL {0}  PASS {1}  FAIL {2}" -f $results.Count, $pass, $fail)
$report = [pscustomobject]@{
  finishedAt = (Get-Date).ToString('s')
  os = $os.Caption + ' build ' + $os.BuildNumber
  total = $results.Count
  pass = $pass
  fail = $fail
  results = $results
}
$report | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Out 'vm-accept-report.json') -Encoding UTF8
($results | ForEach-Object { ($(if ($_.ok) { 'PASS' } else { 'FAIL' })) + "`t" + $_.name + "`t" + $_.detail }) |
  Set-Content -Path (Join-Path $Out 'vm-accept-report.txt') -Encoding UTF8
try { Stop-Transcript | Out-Null } catch { }

if (-not $KeepRunning) {
  Write-Host 'Shutting the VM down (report already written to the mapped folder)...'
  Start-Sleep -Seconds 3
  shutdown.exe /s /t 5 /c 'DSHL VM acceptance finished'
}
