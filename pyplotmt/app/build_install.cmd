@echo off
setlocal

set "CANDLE=C:\Progra~2\WiX Toolset v3.11\bin\candle.exe"
set "LIGHT=C:\Progra~2\WiX Toolset v3.11\bin\light.exe"
set "ROOT=%~dp0"
set "PYTHON=C:\mql\Python3.12\venv\Scripts\python.exe"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "WIXOBJ=%ROOT%\installer\wix\PyPlot-MT.wixobj"
set "WXS=%ROOT%\installer\wix\PyMTPlot.wxs"
set "MSI=%ROOT%\installer\wix\PyPlot-MT.msi"
set "DISTMSI=%ROOT%\dist\PyPlot-MT.msi"
set "APPFILE=%ROOT%src\pyshared_hub\PyShared_hub_ui.py"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "VERSIONFILE=%ROOT%VERSION.txt"

if not exist "%CANDLE%" (
  echo WiX candle.exe nao encontrado: %CANDLE%
  pause
  exit /b 1
)
if not exist "%LIGHT%" (
  echo WiX light.exe nao encontrado: %LIGHT%
  pause
  exit /b 1
)

if not exist "%PYTHON%" (
  echo Python nao encontrado: %PYTHON%
  pause
  exit /b 1
)

if not exist "%CSC%" (
  echo csc.exe nao encontrado: %CSC%
  pause
  exit /b 1
)
if exist "%VERSIONFILE%" (
  if not exist "%POWERSHELL%" (
    echo PowerShell nao encontrado: %POWERSHELL%
    pause
    exit /b 1
  )
  "%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "$wxsPath = '%WXS%';" ^
    "$appPath = '%APPFILE%';" ^
    "$v = (Get-Content -Raw '%VERSIONFILE%').Trim();" ^
    "if (-not $v) { Write-Host 'Versao mantida (VERSION.txt vazio).'; exit 0 }" ^
    "if ($v -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+$') { Write-Host 'ERRO: versao invalida em VERSION.txt (use MAJOR.MINOR.PATCH)'; exit 1 }" ^
    "$wxs = Get-Content -Raw $wxsPath;" ^
    "$wxs = [regex]::Replace($wxs, 'Version=\"[0-9]+\\.[0-9]+\\.[0-9]+\"', 'Version=\"' + $v + '\"', 1);" ^
    "Set-Content -NoNewline $wxsPath $wxs;" ^
    "$app = Get-Content -Raw $appPath;" ^
    "$app = [regex]::Replace($app, 'APP_VERSION\\s*=\\s*\"[0-9]+\\.[0-9]+\\.[0-9]+\"', 'APP_VERSION = \"' + $v + '\"', 1);" ^
    "Set-Content -NoNewline $appPath $app;" ^
    "Write-Host ('Versao aplicada: ' + $v);"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

"%PYTHON%" -m zipapp "%ROOT%src\pyshared_hub" -o "%ROOT%dist\PyPlot-MT.pyz"
if errorlevel 1 (
  echo ERRO: zipapp falhou.
  pause
  exit /b 1
)

"%CSC%" /nologo /t:winexe /out:"%ROOT%dist\PyPlot-MT.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll "%ROOT%launcher\PyMTPlotLauncher.cs"
if errorlevel 1 (
  echo ERRO: csc.exe falhou.
  pause
  exit /b 1
)

"%CANDLE%" -nologo -out "%WIXOBJ%" "%WXS%"
if errorlevel 1 (
  echo ERRO: candle.exe falhou.
  pause
  exit /b 1
)

"%LIGHT%" -nologo -ext WixUIExtension -out "%MSI%" "%WIXOBJ%"
if errorlevel 1 (
  echo ERRO: light.exe falhou.
  pause
  exit /b 1
)

copy /y "%MSI%" "%DISTMSI%" >nul
