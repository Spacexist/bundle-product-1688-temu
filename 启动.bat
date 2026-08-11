@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Always run from the directory that contains this file.
cd /d "%~dp0"
if errorlevel 1 goto :path_error

set "NODE_HOME=%~dp0runtime\node"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "NPM_CMD=%NODE_HOME%\npm.cmd"

rem Use the bundled Node runtime. Quoted paths support spaces and Chinese names.
if not exist "%NODE_EXE%" goto :node_error
if not exist "%NPM_CMD%" goto :node_error
if not exist "%~dp0package.json" goto :project_error
set "PATH=%NODE_HOME%;%PATH%"

rem Install dependencies only when the transferred folder does not contain them.
if not exist "%~dp0node_modules\.package-lock.json" (
  echo [SETUP] Installing project dependencies...
  call "%NPM_CMD%" install
  if errorlevel 1 goto :install_error
)

echo [START] Bundled Node version:
"%NODE_EXE%" -v
if errorlevel 1 goto :node_error
if /i "%~1"=="--check" (
  echo [OK] Startup environment check passed.
  exit /b 0
)
echo [START] Open http://127.0.0.1:5173 if the browser does not open.

rem Open the browser after the local services have had time to start.
start "" powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5173'"
call "%NPM_CMD%" run dev
set "APP_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%APP_EXIT_CODE%"=="0" echo [ERROR] The service stopped with exit code %APP_EXIT_CODE%.
if "%APP_EXIT_CODE%"=="0" echo [INFO] The service has stopped.
pause
exit /b %APP_EXIT_CODE%

:path_error
echo [ERROR] Cannot open the project directory.
goto :fatal_exit

:node_error
echo [ERROR] Bundled Node is missing or cannot run.
echo Expected file: "%~dp0runtime\node\node.exe"
goto :fatal_exit

:project_error
echo [ERROR] package.json is missing from the project directory.
goto :fatal_exit

:install_error
echo [ERROR] npm install failed. Check the network connection and try again.
goto :fatal_exit

:fatal_exit
echo.
pause
exit /b 1
