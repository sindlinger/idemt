@echo off
setlocal

set "DEFAULT_PY=C:\mql\Python3.12\venv\Scripts\python.exe"
set "CFG=%~dp0pymtplot_python_path.txt"
set "PYEXE="

if exist "%CFG%" (
  set /p PYEXE=<"%CFG%"
)

if "%PYEXE%"=="" (
  set "PYEXE=%DEFAULT_PY%"
)

if not exist "%PYEXE%" (
  echo [PyPlot-MT] Python not found: "%PYEXE%"
  echo [PyPlot-MT] Edit "%CFG%" and put the full path to python.exe
  pause
  exit /b 1
)

"%PYEXE%" "%~dp0PyShared_hub_ui.py"
