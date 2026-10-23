@echo off
rem Starts the trainer-coach server (if not running) and opens the app in Chrome or Edge.
rem Web Bluetooth needs a secure origin; ride history lives in this origin's browser storage, so keep the port fixed.
setlocal
cd /d "%~dp0"
if "%HW_PORT%"=="" set HW_PORT=8765
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
set PYTHONPATH=%~dp0server;%PYTHONPATH%
netstat -ano | findstr /r /c:"127.0.0.1:%HW_PORT% .*LISTENING" >nul || start "trainer-coach server" /min %PY% -m trainer_coach serve
timeout /t 1 >nul
rem Edge works too: replace chrome with msedge.
start "" chrome http://127.0.0.1:%HW_PORT%/
