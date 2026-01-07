@echo off
setlocal

REM Ajuste o caminho abaixo se o seu Terminal for diferente
set MT5_DATA=C:\Users\pichau\AppData\Roaming\MetaQuotes\Terminal\EDC2DBD7187032A6326EC5B7406951FA

set SRC=C:\git\mt5ide\telnetmt

if not exist "%MT5_DATA%\MQL5" (
  echo MQL5 nao encontrado em %MT5_DATA%
  exit /b 1
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
