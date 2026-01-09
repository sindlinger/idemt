param(
  [string]$TerminalHash = "DC3551FDEF6C00FBB128B35E7E6E155B",
  [string]$RepoRoot = "C:\git\mt5ide"
)

$svc = Join-Path $env:APPDATA "MetaQuotes\Terminal\$TerminalHash\MQL5\Services"
$repoServices = Join-Path $RepoRoot "telnetmt\Services"

if (!(Test-Path $svc)) {
  Write-Error "Services path not found: $svc"
  exit 1
}
if (!(Test-Path $repoServices)) {
  Write-Error "Repo services path not found: $repoServices"
  exit 1
}

function Remove-IfExists([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Force -Recurse }
}

Write-Host "Using Services path: $svc"
Write-Host "Using Repo Services: $repoServices"

# Remove broken links if present
Remove-IfExists (Join-Path $svc "TelnetMT")
Remove-IfExists (Join-Path $svc "OficialTelnetServiceBootstrap.mq5")

# Junction for TelnetMT folder
New-Item -ItemType Junction -Path (Join-Path $svc "TelnetMT") -Target (Join-Path $RepoRoot "telnetmt") | Out-Null

# Hardlinks for required files
$filesToLink = @(
  "TelnetMT_OficialTelnetServiceBootstrap.mq5",
  "TelnetMT_SocketTelnetService.mq5",
  "TelnetMT_SocketTelnetService.ex5"
)

foreach ($name in $filesToLink) {
  $target = Join-Path $repoServices $name
  $dest = Join-Path $svc $name
  if (Test-Path $target) {
    Remove-IfExists $dest
    New-Item -ItemType HardLink -Path $dest -Target $target | Out-Null
  } else {
    Write-Warning "Missing target file: $target"
  }
}

# Link all .mqh helpers so MetaEditor resolves includes cleanly
Get-ChildItem $repoServices -Filter "*.mqh" | ForEach-Object {
  $dest = Join-Path $svc $_.Name
  if (Test-Path $dest) { Remove-Item $dest -Force }
  New-Item -ItemType HardLink -Path $dest -Target $_.FullName | Out-Null
}

Write-Host "Done. TelnetMT junction + hardlinks installed for $TerminalHash."
