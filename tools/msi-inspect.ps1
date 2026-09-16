# msi-inspect.ps1 — 只读检查官方 Node MSI 的元数据与清单（Windows Installer 数据库 API，**不安装任何东西**）
#
# 用法（必须用 Windows PowerShell 5.1：pwsh 7 的 COM 晚绑定读不到 Record.StringData）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\msi-inspect.ps1 [msi路径]
# 本文件保存为 UTF-8 **带 BOM**（5.1 才会按 UTF-8 解析中文；改文件时别把 BOM 弄丢）。
#
# 用途：发布前断言"我们内置的官方安装包"确实是官方那一份（产品名/版本/升级族/ALLUSERS）、
# 带上决定 npm 全局根的那份 23 字节 npmrc，以及 MSI 自己怎么写 PATH（Environment 表）。
param([string]$Msi = "$PSScriptRoot\..\assets\node-dist\node-v22.23.2-x64.msi")
$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
Write-Host "只读检查：$Msi"
$inst = New-Object -ComObject WindowsInstaller.Installer
$db = $inst.OpenDatabase($Msi, 0) # 0 = msiOpenDatabaseModeReadOnly

Write-Host ''
Write-Host '=== Property：产品身份（是不是官方那份 / 升级关系） ==='
$v = $db.OpenView('SELECT `Property`, `Value` FROM Property')
$v.Execute()
while ($true) {
  $r = $v.Fetch()
  if (-not $r) { break }
  $k = ''
  try { $k = [string]$r.StringData(1) } catch { continue }
  $val = ''
  try { $val = [string]$r.StringData(2) } catch { $val = '' }
  if ($k -match '^(ProductName|ProductVersion|ProductCode|UpgradeCode|Manufacturer|ALLUSERS)$') {
    Write-Host ("  {0,-16} = {1}" -f $k, $val)
  }
}
$v.Close()

Write-Host ''
Write-Host '=== Environment：MSI 自己怎么改 PATH ==='
$v = $db.OpenView('SELECT `Environment`, `Name`, `Value` FROM Environment')
$v.Execute()
$anyEnv = $false
while ($true) {
  $r = $v.Fetch()
  if (-not $r) { break }
  try { $n = [string]$r.StringData(1); $name = [string]$r.StringData(2); $val = [string]$r.StringData(3) } catch { continue }
  $anyEnv = $true
  Write-Host ("  {0,-26} {1} = {2}" -f $n, $name, $val)
}
$v.Close()
if (-not $anyEnv) { Write-Host '  （Environment 表为空：PATH 由别的机制写）' }

Write-Host ''
Write-Host '=== Shortcut：开始菜单项 ==='
$v = $db.OpenView('SELECT `Name`, `Target`, `Directory_` FROM Shortcut')
$v.Execute()
while ($true) {
  $r = $v.Fetch()
  if (-not $r) { break }
  try { $name = [string]$r.StringData(1); $target = [string]$r.StringData(2) } catch { continue }
  Write-Host ("  {0,-44} -> {1}" -f $name, $target)
}
$v.Close()

Write-Host ''
Write-Host '=== 关键文件（含决定 npm 全局根的 npmrc） ==='
$v = $db.OpenView('SELECT `File`, `FileName`, `FileSize` FROM File')
$v.Execute()
$npmrcSize = ''
while ($true) {
  $r = $v.Fetch()
  if (-not $r) { break }
  try { $key = [string]$r.StringData(1); $fname = [string]$r.StringData(2); $size = [string]$r.StringData(3) } catch { continue }
  if ($key -eq 'npm.rc') { $npmrcSize = $size }
  if ($fname -match '^(npmrc|node\.exe|install_tools\.bat|nodevars\.bat|npm\.cmd|npx\.cmd)$') {
    Write-Host ("  {0,-22} {1,12} B   (key={2})" -f $fname, $size, $key)
  }
}
$v.Close()
Write-Host ''
if ($npmrcSize) {
  Write-Host ("  [OK] 内置包里有 npmrc（{0} 字节）—— 官方安装器靠它把 npm 全局根指到 %APPDATA%\npm" -f $npmrcSize)
} else {
  Write-Host '  [!!] 没找到 npmrc：这份包不会设置 npm 全局根，必须先查清楚再用'
}

Write-Host ''
Write-Host '只读检查完成：未写注册表、未落位任何文件。'