# accept-node-msi.ps1 — runs INSIDE Windows Sandbox (or any disposable Windows VM).
#
# Purpose: end-to-end acceptance of the official Node MSI install path used by DSHL.
# It installs the official MSI machine-wide, asserts the full MSI footprint (the "identical to
# nodejs.org .msi" checklist), asserts DSHL's own decision/registry code against the real machine,
# then uninstalls and asserts the machine is clean again.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI, so non-ASCII here
# would be mangled. Chinese documentation lives in tools/vm-accept/README.md (host side).
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

$results = New-Object System.Collections.ArrayList
function A([string]$name, [bool]$ok, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail })
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1} :: {2}" -f $tag, $name, $detail)
}
function Step([string]$msg) { Write-Host ''; Write-Host ("=== " + $msg + " ===") }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
# 第一件事就落一个"我跑起来了"的标记：宿主侧据此区分「沙箱没起来 / LogonCommand 没执行」与「脚本卡在某一步」
$startedMark = Join-Path $Out 'vm-started.txt'
try { ("started {0} host={1} user={2}" -f (Get-Date -Format s), $env:COMPUTERNAME, $env:USERNAME) | Set-Content -Path $startedMark -Encoding UTF8 } catch { }
$log = Join-Path $Out 'vm-accept-transcript.txt'
try { Start-Transcript -Path $log -Force | Out-Null } catch { }

# 期望哈希可以由宿主机 runner 写进映射目录（避免把哈希硬编码进 .wsb）
if (-not $ExpectedSha256) {
  $hashFile = Join-Path $Out 'expected-sha256.txt'
  if (Test-Path $hashFile) { $ExpectedSha256 = ((Get-Content $hashFile -Raw).Trim() -split '\s+')[0] }
}

# 沙箱里 UAC 行为不确定：万一不是高完整性令牌，用 RunAs 再拉一次自己（UAC 关闭时静默通过）
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
  A 'msi/present' $true ($msi.Name + '  ' + [math]::Round($msi.Length / 1MB, 1) + ' MB')
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
  # 1730/1925 = 权限不足（沙箱里 UAC 行为不确定）→ 用 RunAs 再试一次
  if ($code -eq 1730 -or $code -eq 1925) {
    Write-Host ('msiexec exit ' + $code + ' (needs elevation) -> retrying via RunAs')
    $p2 = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', $work, '/qn', '/norestart', '/l*v', $msiLog) -Wait -PassThru
    $code = $p2.ExitCode
  }
  A 'install/exit-code' ($code -eq 0 -or $code -eq 3010) ('msiexec exit ' + $code + ' (0/3010 = success)')
  Remove-Item $work -Force -ErrorAction SilentlyContinue

  Step 'refresh this session PATH from the registry (== what a NEW shell/logon inherits)'
  # MSI 只改注册表里的 PATH，当前进程的环境变量不会自己刷新（这正是"装完要新开终端"的原因）。
  # 后面凡是"新终端里能不能用"的断言，都必须先按注册表重建 PATH，否则测的是安装前的旧环境。
  $machinePathNow = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
  $userPathNow = ''
  try { $userPathNow = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
  $env:PATH = [Environment]::ExpandEnvironmentVariables($machinePathNow) + ';' + [Environment]::ExpandEnvironmentVariables($userPathNow)
  A 'env/refreshed-from-registry' ($env:PATH -like '*Program Files\nodejs*') ('PATH rebuilt from registry, ' + $env:PATH.Length + ' chars')

  Step 'footprint 1/7: files land in C:\Program Files\nodejs'
  $nodeExe = 'C:\Program Files\nodejs\node.exe'
  A 'footprint/program-files-node.exe' (Test-Path $nodeExe) $nodeExe
  if (Test-Path $nodeExe) {
    $ver = (& $nodeExe -v) 2>$null
    A 'footprint/node-version' ($ver -eq 'v22.23.2') ('node -v = ' + $ver)
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
  $uninstallKeys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Node.js' } | Select-Object -First 1
  A 'footprint/apps-and-features' ($null -ne $entry -and $entry.DisplayVersion -eq '22.23.2') `
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
  $npmCmd = 'C:\Program Files\nodejs\npm.cmd'
  $prefix = ''
  if (Test-Path $npmCmd) { $prefix = (& $npmCmd config get prefix) 2>$null }
  $expectedPrefix = Join-Path $env:APPDATA 'npm'
  A 'semantics/npm-config-get-prefix' ($prefix -eq $expectedPrefix) ('prefix=' + $prefix + ' expected=' + $expectedPrefix)

  Step 'semantics: node/npm reachable from a FRESH process via machine PATH'
  $fresh = & cmd.exe /c 'node -v && npm -v' 2>$null
  $freshText = ($fresh -join ' ')
  A 'semantics/fresh-shell-node-npm' ($freshText -match 'v22\.23\.2') ('node/npm via PATH: ' + $freshText)

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

  Step 'DSHL code against the real machine (reuse / refuse / migrate decisions)'
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
  const refuse = envInstall.decideNodeInstallPlan({ nodeOk: false, installedMsi: { version: '18.20.0' }, versionManager: vm })
  const live = envInstall.decideNodeInstallPlan({ nodeOk: s.node.status === 'ok', nodeVersion: s.node.version, installedMsi: msi, versionManager: vm })
  console.log(JSON.stringify({
    registryMsi: msi,
    versionManager: vm,
    detect: { node: s.node.status + '/' + s.node.version, nodeSource: s.node.source, dsh: s.dsh.status + '/' + s.dsh.kind, root: s.dsh.root, ready: s.ready, legacyNode: s.legacyNode },
    planWithInstalledMsi: reuse,
    planWithOldMsi: refuse,
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
    A 'dshl/registry-reads-official-msi' ($j.registryMsi.version -eq '22.23.2') ('version=' + $j.registryMsi.version + ' installPath=' + $j.registryMsi.installPath)
    A 'dshl/plan-reuses-installed-msi' ($j.planWithInstalledMsi.action -eq 'reuse') ('action=' + $j.planWithInstalledMsi.action)
    A 'dshl/plan-refuses-older-msi' ($j.planWithOldMsi.action -eq 'refuse') ('action=' + $j.planWithOldMsi.action + ' reason=' + $j.planWithOldMsi.reason)
    A 'dshl/detect-node-ok' ($j.detect.node -like 'ok/*') ('node=' + $j.detect.node + ' source=' + $j.detect.nodeSource)
  } catch {
    A 'dshl/probe-json' $false ('could not parse probe output: ' + $probeText.Substring(0, [Math]::Min(300, $probeText.Length)))
  }

  Step 'uninstall: msiexec /x {ProductCode} /qn (and prove nothing is left behind)'
  $prodCode = '{D9606E8F-44C3-4F42-9165-0F62294FDD4B}'
  $unLog = Join-Path $Out 'msi-uninstall.log'
  $up = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $prodCode, '/qn', '/norestart', '/l*v', $unLog) -Wait -PassThru
  A 'uninstall/exit-code' ($up.ExitCode -eq 0 -or $up.ExitCode -eq 3010) ('msiexec /x exit ' + $up.ExitCode)
  Start-Sleep -Seconds 2
  A 'uninstall/program-files-gone' (-not (Test-Path $nodeExe)) ('node.exe still there: ' + (Test-Path $nodeExe))
  $machinePath2 = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name Path).Path
  A 'uninstall/machine-path-clean' ($machinePath2 -notlike '*Program Files\nodejs*') 'PATH entry removed by the MSI'
  $userPath2 = ''
  try { $userPath2 = (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction Stop).Path } catch { }
  A 'uninstall/user-path-clean' ($userPath2 -notlike '*npm*') ('raw=' + $userPath2)
  $entry2 = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Node.js' } | Select-Object -First 1
  A 'uninstall/apps-and-features-clean' ($null -eq $entry2) $(if ($entry2) { 'still registered' } else { 'not registered anymore' })
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
