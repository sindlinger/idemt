@echo off
setlocal

REM Ajuste o caminho abaixo se o seu Terminal for diferente
REM Ou defina a variavel de ambiente MT5_DATA antes de rodar este .bat
if not defined MT5_DATA (
  if exist "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\DC3551FDEF6C00FBB128B35E7E6E155B\MQL5" (
    set MT5_DATA=C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\DC3551FDEF6C00FBB128B35E7E6E155B
  ) else (
    if exist "C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\EDC2DBD7187032A6326EC5B7406951FA\MQL5" (
      set MT5_DATA=C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\EDC2DBD7187032A6326EC5B7406951FA
    )
  )
)

set SRC=C:\git\mt5ide\telnetmt

if not exist "%MT5_DATA%\MQL5" (
  echo MQL5 nao encontrado em %MT5_DATA%
  exit /b 1
)

if not exist "%MT5_DATA%\MQL5\Services" mkdir "%MT5_DATA%\MQL5\Services"
if not exist "%MT5_DATA%\MQL5\Experts" mkdir "%MT5_DATA%\MQL5\Experts"
if not exist "%MT5_DATA%\MQL5\Scripts" mkdir "%MT5_DATA%\MQL5\Scripts"

REM Limpa lixo antigo (ex.: arquivo TelnetMT 0 bytes)
if exist "%MT5_DATA%\MQL5\Services\TelnetMT" (
  rmdir /S /Q "%MT5_DATA%\MQL5\Services\TelnetMT" >nul 2>&1
  del /F /Q "%MT5_DATA%\MQL5\Services\TelnetMT" >nul 2>&1
)
if exist "%MT5_DATA%\MQL5\Experts\TelnetMT" (
  rmdir /S /Q "%MT5_DATA%\MQL5\Experts\TelnetMT" >nul 2>&1
  del /F /Q "%MT5_DATA%\MQL5\Experts\TelnetMT" >nul 2>&1
)
if exist "%MT5_DATA%\MQL5\Scripts\TelnetMT" (
  rmdir /S /Q "%MT5_DATA%\MQL5\Scripts\TelnetMT" >nul 2>&1
  del /F /Q "%MT5_DATA%\MQL5\Scripts\TelnetMT" >nul 2>&1
)

REM Junctions (pastas)
mklink /J "%MT5_DATA%\MQL5\Services\TelnetMT" "%SRC%"
mklink /J "%MT5_DATA%\MQL5\Experts\TelnetMT" "%SRC%\Experts"
mklink /J "%MT5_DATA%\MQL5\Scripts\TelnetMT" "%SRC%\Scripts"

REM Copia do servico na raiz (MT5 exige o .mq5/.ex5 na raiz de Services)
copy /Y "%SRC%\TelnetMT_SocketTelnetService.mq5" "%MT5_DATA%\MQL5\Services\"
copy /Y "%SRC%\TelnetMT_SocketTelnetService.ex5" "%MT5_DATA%\MQL5\Services\"

echo OK
endlocal
