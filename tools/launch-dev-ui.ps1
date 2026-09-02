# launch-dev-ui.ps1 — 隔离启动 dev 面板预览 UI 改动（DSH_HOME/user-data/端口全隔离）
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\gonghaoyan\Desktop\dshl'
$base = Join-Path $env:TEMP ("dshl-ui-preview-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$dshHome = Join-Path $base 'dshl-home'
$userData = Join-Path $base 'user-data'
foreach ($d in @('profiles','sessions','attachments','storages','dshl')) { New-Item -ItemType Directory -Path (Join-Path $dshHome $d) -Force | Out-Null }
cmd /c mklink /J "$dshHome\profiles\web" "$env:USERPROFILE\.dsh\profiles\web" | Out-Null
"$base" | Set-Content (Join-Path $base 'base.txt') -Encoding utf8
$env:DSH_HOME = $dshHome
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$psi.Arguments = ". --port 4398 --user-data-dir=`"$userData`""
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['DSH_HOME'] = $dshHome
$proc = [System.Diagnostics.Process]::Start($psi)
"started pid=$($proc.Id)"
"base=$base"
