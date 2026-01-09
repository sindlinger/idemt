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

Write-Host "Done. TelnetMT junction installed for $TerminalHash."
