@echo off
setlocal EnableExtensions DisableDelayedExpansion
cls
title Auto Bundle Startup

set "PROJECT_ROOT=%~dp0"
set "PROJECT_ROOT_ARG=%PROJECT_ROOT%."
cd /d "%PROJECT_ROOT%"

set "NODE_EXE=%PROJECT_ROOT%runtime\node\node.exe"
set "NPM_CMD=%PROJECT_ROOT%runtime\node\npm.cmd"
set "PYTHON_EXE=%PROJECT_ROOT%bundle\python-runtime\python.exe"
set "PYTHONPATH=%PROJECT_ROOT%bundle\python-cpu\Lib\site-packages;%PYTHONPATH%"
set "DOCTOR_EXE=%PROJECT_ROOT%env-doctor.exe"
set "DOCTOR_PY=%PROJECT_ROOT%env_doctor.py"

if not exist "%NODE_EXE%" set "NODE_EXE=node"
if not exist "%NPM_CMD%" set "NPM_CMD=npm"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

rem Disable QuickEdit for this console so mouse selection cannot pause startup.
"%PYTHON_EXE%" -c "import ctypes,operator;k=ctypes.windll.kernel32;h=k.GetStdHandle(-10);m=ctypes.c_uint();ok=k.GetConsoleMode(h,ctypes.byref(m));ok and k.SetConsoleMode(h,operator.or_(operator.and_(m.value,0xffffffbf),0x80))" >nul 2>&1

"%NODE_EXE%" "server\scripts\desktop-launcher.js"
if errorlevel 1 echo [Auto Bundle] Warning: desktop shortcut could not be checked.

"%NODE_EXE%" "server\scripts\start-local-services.js" --probe >nul 2>&1
if not errorlevel 1 (
  echo [Auto Bundle] Services already running. Opening workbench now.
  start "" "http://127.0.0.1:5173"
  echo Opened http://127.0.0.1:5173
  endlocal
  exit /b 0
)

echo.
echo [Auto Bundle] CLI startup
echo Project: %PROJECT_ROOT%
echo Node: %NODE_EXE%
echo NPM:  %NPM_CMD%
echo.

call :progress "###-------" "30%%" "Running fast startup checks..."
set "DOCTOR_MODE="
if exist "%PYTHON_EXE%" if exist "%DOCTOR_PY%" set "DOCTOR_MODE=python"
if not defined DOCTOR_MODE if exist "%DOCTOR_EXE%" set "DOCTOR_MODE=exe"

if "%DOCTOR_MODE%"=="python" (
  "%PYTHON_EXE%" "%DOCTOR_PY%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --quick-start --kill-ports 3000,5173,9990
)
if "%DOCTOR_MODE%"=="exe" (
  "%DOCTOR_EXE%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --skip-clip-check --kill-ports 3000,5173,9990
)
if not defined DOCTOR_MODE (
  "%PYTHON_EXE%" "%DOCTOR_PY%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --quick-start --kill-ports 3000,5173,9990
)
if errorlevel 1 (
  echo.
  echo [Auto Bundle] Startup failed. Check the error above.
  pause
  endlocal
  exit /b 1
)

call :progress "#######---" "70%%" "Starting backend and workbench..."
"%NODE_EXE%" "server\scripts\start-local-services.js"
if errorlevel 1 (
  echo.
  echo [Auto Bundle] Startup failed. Check the error above.
  pause
  endlocal
  exit /b 1
)

call :progress "##########" "100%%" "Startup succeeded."
start "" "http://127.0.0.1:5173"
echo Opened http://127.0.0.1:5173
endlocal
exit /b 0

rem Render one startup progress bar line in plain cmd-compatible text.
:progress
echo.
echo Progress: [%~1] %~2 - %~3
exit /b 0
