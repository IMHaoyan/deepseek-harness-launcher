# verify-dev.ps1 v5 — profile 用 junction（pnpm junction 农场不可浅拷贝）；截图带重试
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\gonghaoyan\Desktop\dshl'
$base = Join-Path $env:TEMP ("dshl-verify-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$dshHome = Join-Path $base 'dshl-home'
$userData = Join-Path $base 'user-data'
$shots = Join-Path $base 'shots'
$timeline = Join-Path $base 'timeline.txt'
function Log([string]$m) { $m | Out-File -FilePath $timeline -Encoding utf8 -Append }

foreach ($d in @('profiles','sessions','attachments','storages','dshl')) { New-Item -ItemType Directory -Path (Join-Path $dshHome $d) -Force | Out-Null }
# pnpm junction 农场不能浅拷贝：直接 junction 到真实 web profile（只读共享，与运行中的服务同源）
Remove-Item (Join-Path $dshHome 'profiles\web') -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$dshHome\profiles\web" "$env:USERPROFILE\.dsh\profiles\web" | Out-Null
'{"port":4398,"useSystemBrowser":false,"autoRestart":true}' | Set-Content -Path (Join-Path $dshHome 'dshl\config.json') -Encoding utf8 -Force
Log "base=$base"
Log "profile junction=$(Test-Path (Join-Path $dshHome 'profiles\web\package.json'))"
$devLog = Join-Path $dshHome 'dshl-logs\dshl.log'

function Snap([string]$name) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction SilentlyContinue
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
      $bmp.Save((Join-Path $shots "$name.png"))
      $g.Dispose(); $bmp.Dispose()
      Log "snap $name (try $i)"
      return
    } catch { Start-Sleep -Milliseconds 500 }
  }
  Log "snap $name FAILED after 3 tries"
}
function Wait-Log([string]$pattern, [int]$seconds) {
  $t0 = Get-Date
  while ((Get-Date) -lt $t0.AddSeconds($seconds)) {
    if (Test-Path $devLog) {
      if (Select-String -Path $devLog -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) { return $true }
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}
function Wait-Port([int]$port, [int]$seconds) {
  $t0 = Get-Date
  while ((Get-Date) -lt $t0.AddSeconds($seconds)) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$psi.Arguments = ". --port 4398 --user-data-dir=`"$userData`""
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['DSH_HOME'] = $dshHome
$proc = [System.Diagnostics.Process]::Start($psi)
Log "electron pid=$($proc.Id) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$w = Wait-Log 'web win created' 120
Log "webwin=$w at $(Get-Date -Format 'HH:mm:ss')"
Start-Sleep -Seconds 3
Snap 't-loading'

$t0 = Get-Date
$ready = Wait-Port 4398 300
Log "ready=$ready loading_duration=$([math]::Round(((Get-Date)-$t0).TotalSeconds,1))s at $(Get-Date -Format 'HH:mm:ss')"
Start-Sleep -Seconds 6
Snap 't-ready'

$lp = Get-NetTCPConnection -LocalPort 4398 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$dshPid = if ($lp) { $lp.OwningProcess } else { 0 }
Log "kill DSH pid=$dshPid"
if ($dshPid -and $dshPid -ne 0) { taskkill /F /PID $dshPid | Out-Null }
Start-Sleep -Seconds 2
Snap 't-restart-a'
$t0 = Get-Date
$ready2 = Wait-Port 4398 150
Log "ready2=$ready2 after $([math]::Round(((Get-Date)-$t0).TotalSeconds,1))s"
Start-Sleep -Seconds 5
Snap 't-restored'
$ob = Select-String -Path (Join-Path $dshHome 'dshl-logs\server.out.log') -Pattern 'opening the default browser' -ErrorAction SilentlyContinue | Measure-Object
Log "server_out_open_browser_lines=$($ob.Count)"
Log "ALL DONE at $(Get-Date -Format 'HH:mm:ss')"
