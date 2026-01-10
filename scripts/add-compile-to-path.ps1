param(
  [string]$RepoRoot = "C:\git\mt5ide"
)

$bin = Join-Path $RepoRoot "services\telnetmt\tools"
if (!(Test-Path $bin)) {
  Write-Error "Path not found: $bin"
  exit 1
}

$current = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $current) { $current = "" }

$parts = $current.Split(";") | Where-Object { $_ -ne "" }
$exists = $parts | Where-Object { $_.ToLower() -eq $bin.ToLower() }
if (-not $exists) {
  $newPath = ($parts + $bin) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added to User PATH: $bin"
} else {
  Write-Host "Already in User PATH: $bin"
}

# Also update current process PATH for this session
if (-not ($env:Path.ToLower().Split(";") -contains $bin.ToLower())) {
  $env:Path = "$env:Path;$bin"
}
