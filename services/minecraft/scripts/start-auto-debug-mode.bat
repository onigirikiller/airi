@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

echo [AIRI] Starting auto-debug mode...
echo [AIRI] Minecraft itself is not launched by this script. Start Minecraft with the Fabric mod and open your world if it is not already running.
echo.

call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-stream-gemma-daemon.ps1"
if errorlevel 1 goto :error
echo.

call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-codex-minecraft-daemon.ps1"
if errorlevel 1 goto :error
echo.

call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-codex-daemon-dashboard.ps1"
if errorlevel 1 goto :error
echo.

echo [AIRI] Current daemon status:
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%status-stream-gemma-daemon.ps1"
echo.
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%status-codex-minecraft-daemon.ps1"
echo.
call powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%status-codex-daemon-dashboard.ps1"
echo.

echo [AIRI] Auto-debug mode is ready.
echo [AIRI] Monitor: http://localhost:3002/
echo [AIRI] Codex dashboard: http://localhost:3004/
exit /b 0

:error
echo.
echo [AIRI] Failed to start auto-debug mode.
exit /b 1
