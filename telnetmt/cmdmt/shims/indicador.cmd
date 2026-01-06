@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."
set "CMDMT_INVOKE_AS=indicador"
node "%ROOT%\dist\index.js" %*
