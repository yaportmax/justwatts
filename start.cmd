@echo off
rem Starts the openspin server (if not running) and opens the app in Chrome or Edge.
rem Web Bluetooth needs a secure origin; ride history lives in this origin's browser storage, so keep the port fixed.
setlocal
cd /d "%~dp0"
if "%OPENSPIN_PORT%"=="" set OPENSPIN_PORT=8765
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
set PYTHONPATH=%~dp0server;%PYTHONPATH%
netstat -ano | findstr /r /c:"127.0.0.1:%OPENSPIN_PORT% .*LISTENING" >nul || start "openspin server" /min %PY% -m openspin serve
timeout /t 1 >nul
rem Edge works too: replace chrome with msedge.
start "" chrome http://127.0.0.1:%OPENSPIN_PORT%/
