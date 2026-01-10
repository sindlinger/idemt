param(
  [string]$BinDir = $env:APPDATA + "\\npm"
)

$cmdPath = Join-Path $BinDir "cmdmt.cmd"
$ps1Path = Join-Path $BinDir "cmdmt.ps1"

$cmd = @"
@ECHO off
SETLOCAL
SET dp0=%~dp0
IF EXIST "%dp0%\\node.exe" (
  "%dp0%\\node.exe" "%dp0%\\node_modules\\telnetmt-cmdmt\\dist\\index.js" %*
) ELSE (
  node "%dp0%\\node_modules\\telnetmt-cmdmt\\dist\\index.js" %*
)
"@

$ps1 = @"
`$basedir = Split-Path `$MyInvocation.MyCommand.Definition -Parent
`$nodeLocal = Join-Path `$basedir "node.exe"
`$target = Join-Path `$basedir "node_modules\\telnetmt-cmdmt\\dist\\index.js"
if (Test-Path `$nodeLocal) {
  & `$nodeLocal `$target @args
} else {
  & node `$target @args
}
"@

Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
Set-Content -Path $ps1Path -Value $ps1 -Encoding ASCII

Write-Host "OK: cmdmt shim atualizado em $BinDir"
