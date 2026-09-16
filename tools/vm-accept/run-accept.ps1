# run-accept.ps1 — 宿主机侧：准备结果目录 → 启动 Windows Sandbox → 等报告 → 打印结论
#
# 前置（一次性，需要管理员 + 重启）：
#   Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# 用法：
#   pwsh -File tools\vm-accept\run-accept.ps1 [-TimeoutMinutes 20] [-KeepOpen]
param(
  [int]$TimeoutMinutes = 20,
  [switch]$KeepOpen
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $env:USERPROFILE 'Desktop\dshl-vm-accept'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path $sandboxExe)) {
  Write-Host 'Windows Sandbox 未启用。请用管理员执行并重启：'
  Write-Host '  Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All'
  exit 2
}

$msi = Get-ChildItem (Join-Path $repo 'assets\node-dist') -Filter 'node-v*-x64.msi' -ErrorAction SilentlyContinue |
  Sort-Object Name | Select-Object -Last 1
if (-not $msi) { Write-Host ('缺少内置 MSI：先跑 node tools/fetch-node-dist.mjs'); exit 2 }
$sha = (Get-FileHash -Algorithm SHA256 $msi.FullName).Hash.ToLower()
Write-Host ("内置 MSI：{0}（{1} MB，sha256 {2}…）" -f $msi.Name, [math]::Round($msi.Length / 1MB, 1), $sha.Substring(0, 16))
Set-Content -Path (Join-Path $out 'expected-sha256.txt') -Value ($sha + '  ' + $msi.Name) -Encoding ASCII

$wsb = Join-Path $PSScriptRoot 'WindowsSandbox.wsb'
Write-Host '启动 Windows Sandbox（VM 内会自动安装/验收/卸载官方 MSI）…'
$proc = Start-Process -FilePath $sandboxExe -ArgumentList @($wsb) -PassThru

$report = Join-Path $out 'vm-accept-report.txt'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $report) { break }
  Start-Sleep -Seconds 5
}
if (-not (Test-Path $report)) {
  Write-Host ("超时（{0} 分钟）未拿到报告；结果目录：{1}" -f $TimeoutMinutes, $out)
  Write-Host 'VM 仍在运行的话可以直接在里面看 transcript（C:\vm\out\vm-accept-transcript.txt）。'
  exit 1
}

Start-Sleep -Seconds 2
Write-Host ''
Write-Host '================ VM 验收结果 ================'
Get-Content $report | ForEach-Object {
  $parts = $_ -split "`t"
  if ($parts.Count -ge 2) {
    $mark = if ($parts[0] -eq 'PASS') { '[PASS]' } else { '[FAIL]' }
    Write-Host ("{0} {1}" -f $mark, $parts[1])
    if ($parts.Count -ge 3 -and $parts[2]) { Write-Host ("        " + $parts[2]) }
  } else { Write-Host $_ }
}
Write-Host '============================================'
if (-not $KeepOpen -and -not $proc.HasExited) { Write-Host '（Sandbox 会在脚本结束时自行关机；要保留窗口用 -KeepOpen 并手动关闭）' }
Write-Host ("产物：{0}" -f $out)
