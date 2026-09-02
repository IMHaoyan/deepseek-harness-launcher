# verify-port-block.ps1 v2 — 端口被占用 e2e：占位 → 启动 → CDP 读取说明页并真实点击换端口按钮 → 验证切换
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\gonghaoyan\Desktop\dshl'
$base = Join-Path $env:TEMP ("dshl-portblock-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$dshHome = Join-Path $base 'dshl-home'
$userData = Join-Path $base 'user-data'
$timeline = Join-Path $base 'timeline.txt'
function Log([string]$m) { $m | Out-File -FilePath $timeline -Encoding utf8 -Append }
foreach ($d in @('profiles','sessions','attachments','storages','dshl')) { New-Item -ItemType Directory -Path (Join-Path $dshHome $d) -Force | Out-Null }
cmd /c mklink /J "$dshHome\profiles\web" "$env:USERPROFILE\.dsh\profiles\web" | Out-Null
'{"port":4401,"useSystemBrowser":false,"autoRestart":true}' | Set-Content -Path (Join-Path $dshHome 'dshl\config.json') -Encoding utf8 -Force
Log "base=$base"

function Wait-Port([int]$port, [int]$seconds) {
  $t0 = Get-Date
  while ((Get-Date) -lt $t0.AddSeconds($seconds)) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch {}
    Start-Sleep -Milliseconds 400
  }
  return $false
}
function Cdp-Eval([string]$wsUrl, [string]$js) {
  $out = & node (Join-Path $repo 'tools\cdp-eval.js') $wsUrl $js 2>&1
  return ($out -join "`n")
}

# 1) 占位 4401（非 DSH 指纹）
$occupyFile = Join-Path $base 'occupy.js'
$code = "const net=require('net');net.createServer((s)=>{s.on('data',()=>s.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><title>Some Other App</title></html>'))}).listen(4401,'127.0.0.1',()=>console.log('occupy ok'))"
[System.IO.File]::WriteAllText($occupyFile, $code, [System.Text.Encoding]::UTF8)
$occupy = Start-Process node.exe -ArgumentList $occupyFile -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
$occupyOk = Wait-Port 4401 3
Log "occupy started pid=$($occupy.Id), 4401 occupied=$occupyOk, script bytes=$((Get-Item $occupyFile).Length)"
if (-not $occupyOk) { Log "ABORT: 占位失败"; exit 1 }

# 2) 启动打包版（含远程调试端口供 CDP 点击）
$env:DSH_HOME = $dshHome
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $repo 'dist\win-unpacked\DeepSeek Harness Launcher.exe'
$psi.Arguments = "--port 4401 --user-data-dir=`"$userData`" --remote-debugging-port=9333"
$psi.WorkingDirectory = Join-Path $repo 'dist\win-unpacked'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['DSH_HOME'] = $dshHome
$proc = [System.Diagnostics.Process]::Start($psi)
Log "dshl pid=$($proc.Id) at $(Get-Date -Format 'HH:mm:ss')"
Start-Sleep -Seconds 14

# 3) 收集证据：日志 + CDP target 列表
Get-Content (Join-Path $dshHome 'dshl-logs\dshl.log') -Encoding utf8 -ErrorAction SilentlyContinue | Select-String -Pattern '占用|probe|blocked|starting DSH|ready on' | ForEach-Object { Log "LOG> $($_.Line)" }
try {
  $targets = (Invoke-WebRequest -Uri 'http://127.0.0.1:9333/json' -UseBasicParsing -TimeoutSec 5).Content
  Set-Content -Path (Join-Path $base 'targets.json') -Value $targets -Encoding utf8
  Log "targets: $targets"
} catch { Log "CDP list failed: $($_.Exception.Message)" }

# 4) 通过 CDP 读取并点击 Web 窗口说明页按钮（换到端口 4402 并启动）
$targetsJson = Get-Content (Join-Path $base 'targets.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$webTarget = $targetsJson | Where-Object { $_.url -like '*loading.html*' } | Select-Object -First 1
if ($webTarget) {
  $h1 = Cdp-Eval $webTarget.webSocketDebuggerUrl "document.getElementById('title').textContent"
  $btn = Cdp-Eval $webTarget.webSocketDebuggerUrl "document.getElementById('btnReload').textContent"
  Log "WEB PAGE title=$h1"
  Log "WEB PAGE button=$btn"
  Log "CLICKING WEB BUTTON..."
  Cdp-Eval $webTarget.webSocketDebuggerUrl "document.getElementById('btnReload').click(); 'clicked'" | Out-Null
} else { Log "web loading target not found" }
Start-Sleep -Seconds 12
Log "4402 listener now=$(Wait-Port 4402 5)"
Get-Content (Join-Path $dshHome 'dshl-logs\dshl.log') -Encoding utf8 -ErrorAction SilentlyContinue | Select-Object -Last 10 | ForEach-Object { Log "LOG> $($_.Line)" }
Log "ALL DONE"
