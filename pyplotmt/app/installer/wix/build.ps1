$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wxs = Join-Path $here "PyMTPlot.wxs"
$out = Join-Path $here "PyPlot-MT.msi"
$obj = Join-Path $here "PyPlot-MT.wixobj"

function Resolve-WixV3 {
  $candidates = @(
    "C:\\Program Files (x86)\\WiX Toolset v3.11\\bin",
    "C:\\Program Files (x86)\\WiX Toolset v3.14\\bin",
    "C:\\Program Files\\WiX Toolset v3.11\\bin",
    "C:\\Program Files\\WiX Toolset v3.14\\bin"
  )

  foreach ($dir in $candidates) {
    $candle = Join-Path $dir "candle.exe"
    $light = Join-Path $dir "light.exe"
    if ((Test-Path $candle) -and (Test-Path $light)) {
      return @{ Candle = $candle; Light = $light }
    }
  }

  return $null
}

$wix3 = Resolve-WixV3
if ($null -ne $wix3) {
  & $wix3.Candle -nologo -out $obj $wxs
  & $wix3.Light -nologo -out $out $obj
  exit 0
}

if (Get-Command wix -ErrorAction SilentlyContinue) {
  wix build $wxs -o $out
  exit 0
}

throw "WiX not found. Install WiX v3 (candle/light) or WiX v4 (wix.exe)."
