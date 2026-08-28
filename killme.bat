@echo off
setlocal EnableExtensions DisableDelayedExpansion
cls
title Auto Bundle Kill Ports

echo [Auto Bundle] Killing local ports: 3000 5173 9990
echo.

call :kill_port 3000
call :kill_port 5173
call :kill_port 9990

echo.
echo [Auto Bundle] Done. You can run the launcher again.
pause
endlocal
exit /b 0

rem Stop every LISTENING process on one TCP port.
:kill_port
set "PORT=%~1"
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo [Auto Bundle] Killing port %PORT% PID %%P ...
  taskkill /PID %%P /T /F >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Could not kill PID %%P on port %PORT%.
  ) else (
    echo [OK] Killed PID %%P on port %PORT%.
  )
)
if not defined FOUND echo [OK] Port %PORT% has no LISTENING process.
exit /b 0
