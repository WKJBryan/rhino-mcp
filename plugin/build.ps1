# Build IntentHarness.rhp without NuGet restore (SDK restore is broken on this box).
# Usage: powershell -File plugin/build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root "plugin"
$src = Join-Path $plugin "src"
$out = Join-Path $plugin "bin"
$dotnet = "C:\Program Files\dotnet\dotnet.exe"
$csc = "C:\Program Files\dotnet\sdk\8.0.425\Roslyn\bincore\csc.dll"
$refDir = "C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.31\ref\net8.0"
$rhino = "C:\Program Files\Rhino 8\System\RhinoCommon.dll"

New-Item -ItemType Directory -Force -Path $out | Out-Null

$refs = @()
$refs += "-r:`"$rhino`""
Get-ChildItem $refDir -Filter *.dll | ForEach-Object { $refs += "-r:`"$($_.FullName)`"" }

$files = Get-ChildItem $src -Filter *.cs | ForEach-Object { "`"$($_.FullName)`"" }

$dll = Join-Path $out "IntentHarness.dll"
$rhp = Join-Path $out "IntentHarness.rhp"

$args = @(
  "exec", $csc,
  "-nologo",
  "-target:library",
  "-langversion:latest",
  "-nullable:disable",
  "-out:`"$dll`"",
  "-platform:anycpu"
) + $refs + $files

& $dotnet @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item $dll $rhp -Force
Write-Host "Built $rhp"
