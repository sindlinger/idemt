$ErrorActionPreference = "Stop"

param(
  [string]$SourceDir = "C:\\mql\\mt5-shellscripts\\dlls\\pyshared",
  [string]$OutDir = "",
  [ValidateSet("Release", "Debug")]
  [string]$Config = "Release"
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $OutDir) {
  $OutDir = Join-Path $repoRoot "releases\\dist\\pyshared"
}

if (-not (Test-Path $SourceDir)) {
  throw "SourceDir not found: $SourceDir"
}

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  throw "cmake not found in PATH"
}

$buildDir = Join-Path $SourceDir "build"
Write-Host "Building PyShared_v2 from $SourceDir"
cmake -S $SourceDir -B $buildDir | Out-Host
cmake --build $buildDir --config $Config | Out-Host

$defaultOut = Join-Path $SourceDir "..\\dist\\COMMOM-DLLS\\releases"
$defaultDll = Join-Path (Resolve-Path $defaultOut) "PyShared_v2.dll"
$dllPath = $defaultDll

if (-not (Test-Path $dllPath)) {
  $dllPath = Get-ChildItem -Path $SourceDir -Filter "PyShared_v2.dll" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $dllPath) {
  throw "PyShared_v2.dll not found after build"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Path $dllPath -Destination $OutDir -Force

$hash = (Get-FileHash -Algorithm SHA256 -Path $dllPath).Hash.ToLower()
$version = "2.0.0"
$repoManifest = Join-Path $repoRoot "dll\\PyShared_v2.manifest.json"
if (Test-Path $repoManifest) {
  try {
    $content = Get-Content $repoManifest -Raw | ConvertFrom-Json
    if ($content.version) { $version = $content.version }
  } catch { }
}

$manifest = [ordered]@{
  version = $version
  sha256  = $hash
  build   = (Get-Date -Format "yyyy-MM-dd")
  source  = $SourceDir
}

$manifestPath = Join-Path $OutDir "PyShared_v2.manifest.json"
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $manifestPath
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $repoManifest

Write-Host "DLL output: $OutDir\\PyShared_v2.dll"
Write-Host "Manifest: $manifestPath"
