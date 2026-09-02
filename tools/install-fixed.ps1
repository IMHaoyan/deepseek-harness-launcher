# install-fixed.ps1 — 静默安装修复版 v1.0.16 并验证（杀托盘保持服务，安装后重启托盘接管）
$ErrorActionPreference = 'Continue'
$result = Join-Path $env:TEMP 'dshl-install-result.txt'
function Log([string]$m) { $m | Out-File -FilePath $result -Encoding utf8 -Append }
Set-Content -Path $result -Value "start $(Get-Date -Format 'HH:mm:ss')" -Encoding utf8

$exeDir = 'C:\Users\gonghaoyan\AppData\Local\Programs\deepseek-harness-launcher'
$installer = 'C:\Users\gonghaoyan\Desktop\dshl\dist\dshl-1.0.16.exe'

# 1) 杀托盘主进程（不带 /T：DSH 服务子进程保留，会话不断）
$tray = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness Launcher.exe'" | Where-Object { $_.ExecutablePath -like "*$exeDir*" -and $_.CommandLine -notmatch 'type=' } | Select-Object -First 1
if ($tray) { Log "kill tray pid=$($tray.ProcessId)"; taskkill /PID $($tray.ProcessId) /F 2>&1 | Out-Null }
Start-Sleep -Seconds 3
$c = Get-NetTCPConnection -LocalPort 4399 -State Listen -ErrorAction SilentlyContinue
Log "after kill, 4399: $(if ($c) { "ALIVE PID=$($c.OwningProcess)" } else { "DOWN" })"

# 2) 静默安装
if (Test-Path $installer) {
  Log "installing: $installer"
  $p = Start-Process $installer -ArgumentList '/S' -Wait -PassThru
  Log "installer exited code=$($p.ExitCode)"
} else { Log "installer MISSING" }
Start-Sleep -Seconds 6

# 3) 验证安装产物
$asar = Join-Path $exeDir 'resources\app.asar'
if (Test-Path $asar) {
  $chk = & node -e "const asar=require('C:/Users/gonghaoyan/Desktop/dshl/node_modules/@electron/asar');const s=asar.extractFile('$($asar -replace '\\','/')','main.js').toString('utf8');console.log('fixed='+(s.includes('seed = true')));console.log('switch='+(s.includes('switchToSuggestedPort')))" 2>&1
  Log "asar check: $($chk -join '; ')"
} else { Log "asar MISSING" }
$ver = (Get-Item (Join-Path $exeDir 'DeepSeek Harness Launcher.exe') -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Log "installed version: $ver"

# 4) 启动新版托盘
Start-Process (Join-Path $exeDir 'DeepSeek Harness Launcher.exe')
Log "launched new tray at $(Get-Date -Format 'HH:mm:ss')"
Start-Sleep -Seconds 18
$c2 = Get-NetTCPConnection -LocalPort 4399 -State Listen -ErrorAction SilentlyContinue
Log "4399 now: $(if ($c2) { "ALIVE PID=$($c2.OwningProcess)" } else { "DOWN" })"
$t2 = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness Launcher.exe'" | Where-Object { $_.CommandLine -notmatch 'type=' -and $_.ExecutablePath -like "*$exeDir*" }
Log "new tray mains: $($t2.Count)"
Log "DONE $(Get-Date -Format 'HH:mm:ss')"
