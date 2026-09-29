# collect-bridge-diag.ps1 — 「手机连接（DSH Bridge Next）没生效」的一次性取证
#
# 背景：插件行进了 profile 的 bundle 层，但 DSH 的组合树里没有它，市场就永远显示
#「已安装，重启后生效」——重启不会改变。原因分几类（导入失败 / 镜像缺件 / 缺服务 / 服务没重启），
# 只有那台机器上的证据能区分。本脚本把判定所需的全部事实一次打印出来（并复制到剪贴板）。
#
# 用法（在那台机器上粘贴执行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr <raw-url> -OutFile $env:TEMP\diag.ps1; & $env:TEMP\diag.ps1"
# 或直接把本文件内容整段粘进 PowerShell。

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $lines.Add($s) | Out-Null }
function Head([string]$s) { Add-Line ''; Add-Line ('--- ' + $s + ' ---') }

$home_ = $env:USERPROFILE
$dshlLogs = Join-Path $home_ '.dsh\dshl-logs'
$payloads = Join-Path $home_ '.dsh\dshl\bridge-payloads'

Head '环境'
Add-Line ('时间        : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Add-Line ('计算机/用户 : ' + $env:COMPUTERNAME + ' / ' + $env:USERNAME)

Head '版本'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness-launcher\DeepSeek Harness Launcher.exe'
if (Test-Path $exe) { Add-Line ('启动器      : ' + (Get-Item $exe).VersionInfo.FileVersion) } else { Add-Line '启动器      : 未在默认位置找到' }
Add-Line ('dsh         : ' + ((& dsh --version) 2>&1 | Select-Object -First 1))
Add-Line ('node        : ' + ((& node -v) 2>&1 | Select-Object -First 1))
$cfg = Join-Path $home_ '.dsh\dshl\config.json'
if (Test-Path $cfg) {
  $c = Get-Content $cfg -Raw | ConvertFrom-Json
  Add-Line ('渠道        : launcher=' + $c.launcherChannel + ' dsh=' + $c.dshChannel)
  Add-Line ('手机连接开关: ' + $c.remoteConnect.enabled)
}

Head 'profile 里的插件规格'
$pkg = Join-Path $home_ '.dsh\profiles\web\package.json'
if (Test-Path $pkg) {
  $j = Get-Content $pkg -Raw | ConvertFrom-Json
  Add-Line ('dependencies: ' + $j.dependencies.'@agents-anywhere/dsh-bridge-next')
  Add-Line ('in bundles  : ' + ($j.dsh.profile.bundles -contains '@agents-anywhere/dsh-bridge-next'))
} else { Add-Line 'profile package.json 读不到' }

Head 'payload 缓存与解析镜像'
$keys = Get-ChildItem $payloads -Directory | Sort-Object LastWriteTime -Descending
foreach ($k in $keys) {
  $payloadDir = Join-Path $k.FullName 'bridge-next.tgz'
  $v = ''
  if (Test-Path (Join-Path $payloadDir 'package.json')) { $v = (Get-Content (Join-Path $payloadDir 'package.json') -Raw | ConvertFrom-Json).version }
  Add-Line ($k.Name + '  payload=' + $v + '  mtime=' + $k.LastWriteTime.ToString('MM-dd HH:mm'))
}
$latest = $keys | Select-Object -First 1
if ($latest) {
  # 镜像在 payload **旁边**的 node_modules（payload 自己那个 node_modules 是指向 deps 的 junction，
  # 里面只有 4 个运行时依赖）—— 两处都查，避免把正常形态误读成缺件。
  $need = 'cordis', 'dsh-typert-protocol', 'schemastery', 'dsh-session-title', 'dsh-llm', 'dsh-session'
  $mirror = Join-Path $latest.FullName 'node_modules\@deepseek-ai'
  $have = @(Get-ChildItem $mirror -Name | Where-Object { $_ -in $need })
  $missing = @($need | Where-Object { $_ -notin $have })
  Add-Line ('镜像(旁边)     : ' + $(if ($have.Count) { $have -join ', ' } else { '（空/不存在）' }))
  Add-Line ('镜像缺件       : ' + $(if ($missing.Count) { $missing -join ', ' } else { '（无）' }))
  $inner = @(Get-ChildItem (Join-Path $latest.FullName 'bridge-next.tgz\node_modules\@deepseek-ai') -Name)
  Add-Line ('payload 内镜像 : ' + $(if ($inner.Count) { $inner -join ', ' } else { '（无；正常，那是 deps 的 junction）' }))
  $deps = @(Get-ChildItem (Join-Path $latest.FullName 'bridge-next.tgz\node_modules') -Name | Where-Object { $_ -in 'qrcode', 'clsx', 'lucide-react', '@dataiku' })
  Add-Line ('运行时依赖     : ' + $(if ($deps.Count) { $deps -join ', ' } else { '（空/不存在）' }))
  # dsh 安装树是镜像的第三个来源：profile 里缺的包，安装树里往往有（dsh 自己就带着它们）
  $dshBin = (& where.exe dsh 2>$null | Select-Object -First 1)
  if ($dshBin) {
    $tree = Join-Path (Split-Path (Split-Path $dshBin -Parent) -Parent) 'node_modules\@deepseek-ai'
    Add-Line ('dsh 安装树     : ' + $tree)
    Add-Line ('安装树里的缺件 : ' + $(if ($missing.Count) { (@($missing | Where-Object { Test-Path (Join-Path $tree ($_ + '\package.json')) }) -join ', ') + $(if (@($missing | Where-Object { Test-Path (Join-Path $tree ($_ + '\package.json')) }).Count) { '（安装树里能找到，启动器应自行补齐）' } else { '（安装树里也没有）' }) } else { '（无缺件）' }))
  }

  Head '手工 import 复现（与 DSH 启动时同一份解析环境）'
  $entry = 'file:///' + ((Join-Path $latest.FullName 'bridge-next.tgz\lib\index.js') -replace '\\', '/')
  $r = & node --input-type=module -e "import(process.argv[1]).then(()=>{console.log('IMPORT OK')}).catch(e=>{console.log('IMPORT FAIL: ' + String((e&&(e.stack||e.message))||e))})" $entry 2>&1
  foreach ($l in ($r | Select-Object -First 4)) { Add-Line $l }
}

Head '启动器日志（最近 15 条 bridge / 自检 / 未生效）'
$log = Join-Path $dshlLogs 'dshl.log'
if (Test-Path $log) {
  Select-String -Path $log -Pattern '\[bridge\]|解析镜像|启动前 import 自检|插件未生效|updater' |
    Select-Object -Last 15 | ForEach-Object { Add-Line ($_.Line.Substring(0, [Math]::Min(220, $_.Line.Length))) }
} else { Add-Line 'dshl.log 不存在' }

Head 'DSH 服务 stderr（最近 6 条未激活 / 跳过）'
$err = Join-Path $dshlLogs 'server.err.log'
if (Test-Path $err) {
  Select-String -Path $err -Pattern 'did not activate|skipping profile bundle|failed to import|pending \(waiting|disabling profile plugin row' |
    Select-Object -Last 6 | ForEach-Object { Add-Line ($_.Line.Substring(0, [Math]::Min(220, $_.Line.Length))) }
} else { Add-Line 'server.err.log 不存在' }

Head 'DSH 进程'
Get-Process | Where-Object { $_.ProcessName -like '*Harness*' -or $_.ProcessName -eq 'node' } |
  Select-Object -First 6 | ForEach-Object { Add-Line ('  ' + $_.ProcessName + ' pid=' + $_.Id + ' start=' + $_.StartTime) }

$report = ($lines -join "`n")
Write-Output $report
try { Set-Clipboard -Value $report; Write-Output ''; Write-Output '（以上内容已复制到剪贴板，直接粘贴即可）' } catch { }
