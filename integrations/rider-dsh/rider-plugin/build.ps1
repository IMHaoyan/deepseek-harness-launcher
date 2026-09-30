param([string]$RiderHome = 'C:\Program Files\JetBrains\JetBrains Rider 2023.3.4')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$javac = Join-Path $RiderHome 'jbr\bin\javac.exe'
$lib = Join-Path $RiderHome 'lib\*'
if (!(Test-Path -LiteralPath $javac)) { throw "Rider JBR not found: $RiderHome" }
$build = Join-Path $root 'build'
$classes = Join-Path $build 'classes'
New-Item -ItemType Directory -Force -Path $build | Out-Null
# Only clear the exact build/classes directory, never a computed parent or external path.
$absoluteClasses = [IO.Path]::GetFullPath($classes)
$absoluteBuild = [IO.Path]::GetFullPath($build)
if (!$absoluteClasses.StartsWith($absoluteBuild + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build/classes path' }
if (Test-Path -LiteralPath $absoluteClasses) { Remove-Item -LiteralPath $absoluteClasses -Recurse -Force }
New-Item -ItemType Directory -Force -Path $absoluteClasses | Out-Null
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'src\main\java') -Recurse -File -Filter '*.java' | ForEach-Object FullName)
& $javac -encoding UTF-8 --release 17 -cp $lib -d $absoluteClasses $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed: $LASTEXITCODE" }
$output = Join-Path $build 'dsh-rider-bridge.jar'
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($output, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($source in @($absoluteClasses, (Join-Path $root 'src\main\resources'))) {
    foreach ($entry in Get-ChildItem -LiteralPath $source -Recurse -File) {
      $name = $entry.FullName.Substring($source.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entry.FullName, $name) | Out-Null
    }
  }
} finally { $archive.Dispose() }
Write-Output "Built $output"
