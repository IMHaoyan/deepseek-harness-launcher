# verify-webzoom.ps1 - isolated check that conversation (web) zoom persists from config.json
# usage: tools\verify-webzoom.ps1 [-WebZoom 130]   (omit -> control: no webZoom in config)
param([int]$WebZoom = -1)
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\gonghaoyan\Desktop\dshl'
$base = Join-Path $env:TEMP ("dshl-webzoom-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$dshHome = Join-Path $base 'dshl-home'
$userData = Join-Path $base 'user-data'
$devLog = Join-Path $dshHome 'dshl-logs\dshl.log'
$cdpPort = 9333
function Log([string]$m) { $m | Write-Output }

foreach ($d in @('profiles', 'sessions', 'attachments', 'storages', 'dshl', 'dshl-logs')) {
  New-Item -ItemType Directory -Path (Join-Path $dshHome $d) -Force | Out-Null
}
cmd /c mklink /J "$dshHome\profiles\web" "$env:USERPROFILE\.dsh\profiles\web" | Out-Null
Log ("profile junction=" + (Test-Path (Join-Path $dshHome 'profiles\web\package.json')))

# config.json WITHOUT BOM (JSON.parse must succeed for webZoom to load)
$cfg = '{"port":4398,"useSystemBrowser":false,"autoRestart":true'
if ($WebZoom -ge 0) { $cfg += ',"webZoom":' + $WebZoom }
$cfg += '}'
[System.IO.File]::WriteAllText((Join-Path $dshHome 'dshl\config.json'), $cfg, [System.Text.UTF8Encoding]::new($false))
Log ("config=" + $cfg)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$psi.Arguments = ". --port 4398 --user-data-dir=`"$userData`" --remote-debugging-port=$cdpPort"
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['DSH_HOME'] = $dshHome
$proc = [System.Diagnostics.Process]::Start($psi)
Log ("electron pid=" + $proc.Id)

function Wait-CdpList([int]$seconds) {
  $t0 = Get-Date
  while ((Get-Date) -lt $t0.AddSeconds($seconds)) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/list" -TimeoutSec 3
      if ($r -and $r.Count -gt 0) { return $r }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Wait-Target([array]$targets, [string]$pattern, [int]$seconds) {
  $t0 = Get-Date
  while ((Get-Date) -lt $t0.AddSeconds($seconds)) {
    foreach ($t in $targets) {
      if ($t.url -match $pattern) { return $t }
    }
    Start-Sleep -Milliseconds 400
    $targets = (Wait-CdpList 5)
    if (-not $targets) { return $null }
  }
  return $null
}

function Cdp-Eval([string]$wsUrl, [string]$js) {
  $out = & node (Join-Path $repo 'tools\cdp-eval.js') $wsUrl $js 2>&1
  return ($out -join ' ')
}

$list = Wait-CdpList 20
if (-not $list) { Log 'FAILED: no CDP targets'; taskkill /F /T /PID $proc.Id | Out-Null; exit 1 }

# conversation tab: loading page or real app on 4398
$tabTarget = $null
foreach ($t in $list) { if ($t.url -match 'loading\.html|127\.0\.0\.1:4398') { $tabTarget = $t; break } }
if (-not $tabTarget) { $tabTarget = Wait-Target $list 'loading\.html|127\.0\.0\.1:4398' 30 }
if (-not $tabTarget) { Log 'FAILED: web tab target not found'; taskkill /F /T /PID $proc.Id | Out-Null; exit 1 }
Log ("tab url=" + $tabTarget.url)

Start-Sleep -Seconds 2
$dpr = Cdp-Eval $tabTarget.webSocketDebuggerUrl "JSON.stringify({dpr:window.devicePixelRatio,vs:(window.visualViewport?window.visualViewport.scale:-1),href:location.href})"
Log ("tab dpr=" + $dpr)

# panel widget should show persisted webZoom after state push
$panel = $null
foreach ($t in $list) { if ($t.url -match 'index\.html') { $panel = $t; break } }
if ($panel) {
  $txt = ''
  for ($i = 0; $i -lt 20; $i++) {
    $txt = Cdp-Eval $panel.webSocketDebuggerUrl "document.getElementById('btnWebZoom')?document.getElementById('btnWebZoom').textContent:'missing'"
    if ($txt -match '\d+%') { break }
    Start-Sleep -Milliseconds 500
  }
  Log ("panel btnWebZoom=" + $txt)
} else {
  Log 'panel target not found'
}

Start-Sleep -Seconds 1
taskkill /F /T /PID $proc.Id | Out-Null
Log ("base=$base")
Log 'DONE'
