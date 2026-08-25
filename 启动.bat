@echo off
setlocal EnableExtensions DisableDelayedExpansion
cls

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

echo.
echo [Auto Bundle] CLI startup
echo Project: %PROJECT_ROOT%
echo Node: %NODE_EXE%
echo NPM:  %NPM_CMD%
echo.

call :progress "#####-----" "50%%" "Checking and repairing environment..."
if exist "%PYTHON_EXE%" if exist "%DOCTOR_PY%" (
  "%PYTHON_EXE%" "%DOCTOR_PY%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --kill-ports 3000,5173,9990
  goto doctor_done
)
if exist "%DOCTOR_EXE%" (
  "%DOCTOR_EXE%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --kill-ports 3000,5173,9990
) else (
  "%PYTHON_EXE%" "%DOCTOR_PY%" --project-root "%PROJECT_ROOT_ARG%" --repair --install --kill-ports 3000,5173,9990
)
:doctor_done
if errorlevel 1 goto failed

call :progress "########--" "80%%" "Starting backend and workbench in background..."
"%NODE_EXE%" "server\scripts\start-local-services.js"
if errorlevel 1 goto failed

call :progress "##########" "100%%" "Startup succeeded."
start "" "http://127.0.0.1:5173"
echo Opened http://127.0.0.1:5173
endlocal
exit /b 0

:failed
echo.
echo [Auto Bundle] Startup failed. Check the error above.
pause
endlocal
exit /b 1

:end
endlocal
exit /b 0

rem Render one startup progress bar line in plain cmd-compatible text.
:progress
echo.
echo Progress: [%~1] %~2 - %~3
exit /b 0
