# fresh-test.ps1 — 全新机首装向导体验脚本（完全不碰本机真实环境）
#
# 原理：临时 DSH_HOME（%TEMP%\dshl-fresh-test）+ DSHL_FRESH_TEST=1 模拟一台干净的新机器——
#   无视系统 Node/源码仓库/全局 npm/npx 缓存，只认"托管安装"目录（装完就能被检测到）。
#   因此向导会走完整流程：欢迎 → 真实下载安装 Node+DSH → 完成 → 自动打开 DSH（端口 3998，避开真实服务）。
#
# 用法：pwsh -File tools\fresh-test.ps1
# 结束后：关闭启动器，删除 %TEMP%\dshl-fresh-test 即可完全还原。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$freshHome = Join-Path $env:TEMP 'dshl-fresh-test'
Write-Host "== 全新机模拟 =="
Write-Host "DSH_HOME  = $freshHome"
Write-Host "服务端口  = 3998（避开真实 3080）"
Write-Host "注意：本机真实环境不受任何影响；测试完删除该目录即可。"
$env:DSH_HOME = $freshHome
$env:DSHL_FRESH_TEST = '1'
$electron = Join-Path $root 'node_modules\.bin\electron.cmd'
if (-not (Test-Path $electron)) {
  $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
}
if (Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe')) {
  & (Join-Path $root 'node_modules\electron\dist\electron.exe') $root '--port' '3998'
} else {
  & $electron $root '--port' '3998'
}
