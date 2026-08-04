@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "ROOT=%cd%"
set "MC_DIR=%ROOT%\services\minecraft"
set "MC_ENV_LOCAL=%MC_DIR%\.env.local"
set "MC_ENV=%MC_DIR%\.env"
set "COMMON_NODE_OPTIONS=--dns-result-order=ipv4first --use-system-ca"
set "WEB_URL=http://localhost:5173/"
set "LAUNCH_LOG=%ROOT%\runtime\minecraft-local-launcher.log"

call :load_setting_alias LLM_MODEL LLM_MODEL OPENAI_MODEL gemma4:e4b
call :load_setting_alias LLM_REASONING_MODEL LLM_REASONING_MODEL OPENAI_REASONING_MODEL gemma4:e4b
call :load_setting_alias LLM_BASE_URL LLM_BASE_URL OPENAI_API_BASEURL http://localhost:11434/v1
call :load_setting_alias AUTONOMY_LLM_MODEL AUTONOMY_LLM_MODEL GEMINI_MODEL gemma4:e4b
call :load_setting_alias AUTONOMY_LLM_BASE_URL AUTONOMY_LLM_BASE_URL GEMINI_API_BASEURL http://localhost:11434/v1
call :load_setting AIRI_WS_BASEURL ws://localhost:6121/ws
call :load_setting LOCAL_TTS_PROVIDER irodori-tts
call :load_setting LOCAL_TTS_BASEURL http://127.0.0.1:5000
call :load_setting STYLE_BERT_VITS2_SERVER_CMD
call :load_setting IRODORI_TTS_SERVER_CMD
call :load_setting BOT_PORT 25565
call :load_setting FABRIC_BRIDGE_PORT 8089
call :load_setting MONITOR_PORT 3002
call :init_log
call :log "launcher initialized"

echo ============================================
echo AIRI Minecraft Local Launcher
echo ============================================
echo Root                : %ROOT%
echo Minecraft service   : %MC_DIR%
echo Main LLM model      : %LLM_MODEL%
echo Main reasoning      : %LLM_REASONING_MODEL%
echo Main LLM base URL   : %LLM_BASE_URL%
echo Autonomy LLM model  : %AUTONOMY_LLM_MODEL%
echo Autonomy base URL   : %AUTONOMY_LLM_BASE_URL%
echo AIRI WS             : %AIRI_WS_BASEURL%
echo Local TTS provider  : %LOCAL_TTS_PROVIDER%
echo Local TTS base URL  : %LOCAL_TTS_BASEURL%
echo Bot port            : %BOT_PORT%
echo FabricBridge port   : %FABRIC_BRIDGE_PORT%
echo Monitor port        : %MONITOR_PORT%
echo.

if /i "%~1"=="--dry-run" (
  echo [DRY-RUN] Would start:
  echo   1. Ollama ^(if %LLM_BASE_URL% is local and ollama exists^)
  echo   2. Local TTS ^(Irodori-TTS / Style-Bert-VITS2 if configured and not already running^)
  echo   3. pnpm -F @proj-airi/server-runtime dev
  echo   4. pnpm -F @proj-airi/stage-web dev
  echo   5. stop any existing @proj-airi/minecraft-bot dev process, then start pnpm -F @proj-airi/minecraft-bot dev ^(MONITOR_ENABLED=true MONITOR_PORT=%MONITOR_PORT%^)
  echo   6. open http://localhost:%MONITOR_PORT%/
  echo.
  goto :eof
)

if not exist "%ROOT%\package.json" (
  echo [ERROR] package.json was not found under "%ROOT%".
  exit /b 1
)

if not exist "%MC_DIR%\package.json" (
  echo [ERROR] Minecraft workspace was not found under "%MC_DIR%".
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found in PATH.
  echo Run: corepack enable ^&^& corepack prepare pnpm@latest --activate
  exit /b 1
)

call :maybe_start_ollama
call :maybe_start_local_tts
call :tcp_probe %AIRI_WS_BASEURL% AIRI_WS_UP
if "%AIRI_WS_UP%"=="1" (
  echo AIRI runtime is already reachable at %AIRI_WS_BASEURL%.
  call :log "reusing existing airi runtime"
) else (
  call :log "starting airi runtime"
  echo Starting AIRI runtime...
  start "AIRI Runtime" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && pnpm -F @proj-airi/server-runtime dev"
  timeout /t 2 /nobreak >nul
  call :wait_for_tcp %AIRI_WS_BASEURL% AIRI_WS_READY 15
  if "%AIRI_WS_READY%"=="1" (
    echo AIRI runtime is reachable at %AIRI_WS_BASEURL%.
  ) else (
    echo [WARN] AIRI runtime did not become reachable within 15s. The bot will have to reconnect later.
  )
)

call :tcp_probe %WEB_URL% STAGE_WEB_UP
if "%STAGE_WEB_UP%"=="1" (
  echo Stage Web UI is already reachable at %WEB_URL%.
  call :log "reusing existing stage web"
) else (
  call :log "starting stage web"
  echo Starting Stage Web UI...
  start "AIRI Stage Web" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && pnpm -F @proj-airi/stage-web dev"
  timeout /t 2 /nobreak >nul
)

echo Ensuring previous Minecraft bot instance is stopped...
call :log "stopping previous minecraft bot"
call :stop_existing_minecraft_bot

echo Starting Minecraft bot...
call :log "starting minecraft bot"
start "AIRI Minecraft Bot" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && set MONITOR_ENABLED=true && set MONITOR_PORT=%MONITOR_PORT% && pnpm -F @proj-airi/minecraft-bot dev"
timeout /t 2 /nobreak >nul
call :wait_for_minecraft_bot_lock BOT_LOCK_READY 12
if "%BOT_LOCK_READY%"=="1" (
  call :log "minecraft bot lock acquired"
) else (
  call :log "minecraft bot lock did not appear within startup window"
)

call :report_post_launch_status

echo Opening Stage Web UI...
start "" "%WEB_URL%"
echo Opening Monitor Dashboard...
start "" "http://localhost:%MONITOR_PORT%/"
call :log "launcher completed"

echo.
echo Launched.
echo.
echo Notes:
echo - Start Minecraft itself separately with the Fabric mod installed.
echo - The Fabric bridge should listen on ws://localhost:%FABRIC_BRIDGE_PORT%.
echo - If AIRI runtime or local TTS is already running, this launcher leaves them as-is.
echo - Close each opened terminal window to stop the services.
echo.

goto :eof

:init_log
if not exist "%ROOT%\runtime" mkdir "%ROOT%\runtime" >nul 2>nul
> "%LAUNCH_LOG%" echo [%date% %time%] local launcher start
exit /b 0

:log
>> "%LAUNCH_LOG%" echo [%date% %time%] %~1
exit /b 0

:stop_existing_minecraft_bot
set "STOPPED_MINECRAFT_BOT_PIDS="
set "MC_LOCK_PATH=%TEMP%\airi-minecraft-locks\port-%BOT_PORT%.lock"
set "STOP_RESULT="
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lockPath = $env:MC_LOCK_PATH;" ^
  "$targetIds = [System.Collections.Generic.HashSet[int]]::new();" ^
  "if (Test-Path -LiteralPath $lockPath) {" ^
  "  try {" ^
  "    $payload = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json;" ^
  "    foreach ($value in @($payload.parentPid, $payload.pid)) {" ^
  "      $resolvedId = 0;" ^
  "      if ([int]::TryParse([string]$value, [ref]$resolvedId) -and $resolvedId -gt 0) { [void]$targetIds.Add($resolvedId) }" ^
  "    }" ^
  "  } catch {}" ^
  "}" ^
  "Get-CimInstance Win32_Process | Where-Object {" ^
  "  ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe') -and $_.CommandLine -and (" ^
  "    $_.CommandLine -like '*@proj-airi/minecraft-bot dev*' -or" ^
  "    $_.CommandLine -like '*services\\minecraft\\src\\main.ts*' -or" ^
  "    $_.CommandLine -like '*services\\minecraft*tsx*src/main.ts*'" ^
  "  )" ^
  "} | ForEach-Object { [void]$targetIds.Add([int]$_.ProcessId) };" ^
  "$stopped = New-Object System.Collections.Generic.List[int];" ^
  "foreach ($targetId in ($targetIds | Sort-Object -Descending)) {" ^
  "  if ($targetId -le 0) { continue }" ^
  "  try {" ^
  "    Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', $targetId, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null;" ^
  "    $stopped.Add($targetId)" ^
  "  } catch {}" ^
  "}" ^
  "if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }" ^
  "'STOPPED=' + (($stopped | Sort-Object -Unique) -join ' ')"`) do (
  set "STOP_RESULT=%%L"
)

if defined STOP_RESULT (
  set "STOPPED_MINECRAFT_BOT_PIDS=%STOP_RESULT:STOPPED=%"
)

if defined STOPPED_MINECRAFT_BOT_PIDS (
  echo Stopped existing Minecraft bot pids: %STOPPED_MINECRAFT_BOT_PIDS%
  call :log "stopped minecraft bot pids: %STOPPED_MINECRAFT_BOT_PIDS%"
  timeout /t 2 /nobreak >nul
) else (
  echo No existing Minecraft bot process was running.
  call :log "no existing minecraft bot process was running"
)

exit /b 0

:wait_for_minecraft_bot_lock
set "%~1=0"
set "BOT_LOCK_WAIT_PATH=%TEMP%\airi-minecraft-locks\port-%BOT_PORT%.lock"
for /l %%I in (1,1,%~2) do (
  if exist "%BOT_LOCK_WAIT_PATH%" (
    set "%~1=1"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
exit /b 0

:report_post_launch_status
call :tcp_probe %AIRI_WS_BASEURL% POST_AIRI_UP
call :tcp_probe %WEB_URL% POST_STAGE_WEB_UP
call :tcp_probe %LOCAL_TTS_BASEURL% POST_LOCAL_TTS_UP
call :tcp_probe ws://localhost:%FABRIC_BRIDGE_PORT% POST_FABRIC_BRIDGE_UP
call :tcp_probe http://localhost:%MONITOR_PORT%/ POST_MONITOR_UP

echo.
echo Startup status:
if "%POST_AIRI_UP%"=="1" (
  echo   [OK]   AIRI runtime is reachable at %AIRI_WS_BASEURL%
) else (
  echo   [WARN] AIRI runtime is not reachable at %AIRI_WS_BASEURL%
  call :log "post-launch status: airi runtime unreachable"
)
if "%POST_STAGE_WEB_UP%"=="1" (
  echo   [OK]   Stage Web UI is reachable at %WEB_URL%
) else (
  echo   [WARN] Stage Web UI is not reachable at %WEB_URL%
  call :log "post-launch status: stage web unreachable"
)
if "%POST_LOCAL_TTS_UP%"=="1" (
  echo   [OK]   Local TTS is reachable at %LOCAL_TTS_BASEURL%
) else (
  echo   [WARN] Local TTS is not reachable at %LOCAL_TTS_BASEURL%
  call :log "post-launch status: local tts unreachable"
)
if "%BOT_LOCK_READY%"=="1" (
  echo   [OK]   Minecraft bot process acquired its instance lock
) else (
  echo   [WARN] Minecraft bot did not acquire its instance lock
  call :log "post-launch status: minecraft bot lock missing"
)
if "%POST_FABRIC_BRIDGE_UP%"=="1" (
  echo   [OK]   Fabric bridge is reachable at ws://localhost:%FABRIC_BRIDGE_PORT%
) else (
  echo   [WARN] Fabric bridge is not reachable at ws://localhost:%FABRIC_BRIDGE_PORT%
  echo          Minecraft must be running with the AIRI Fabric mod, and if the bridge failed to bind at startup you need to restart Minecraft.
  call :log "post-launch status: fabric bridge unreachable"
)
if "%POST_MONITOR_UP%"=="1" (
  echo   [OK]   Monitor dashboard is reachable at http://localhost:%MONITOR_PORT%/
) else (
  echo   [WARN] Monitor dashboard is not reachable at http://localhost:%MONITOR_PORT%/
  echo          The dashboard stays down until the Minecraft bot fully initializes, which currently depends on a live Fabric bridge.
  call :log "post-launch status: monitor dashboard unreachable"
)
echo.
exit /b 0

:load_setting_alias
set "TARGET_NAME=%~1"
set "PRIMARY_NAME=%~2"
set "LEGACY_NAME=%~3"
set "SETTING_DEFAULT=%~4"
set "SETTING_VALUE="

if exist "%MC_ENV_LOCAL%" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%PRIMARY_NAME%=" "%MC_ENV_LOCAL%" 2^>nul') do (
    set "SETTING_VALUE=%%B"
  )
)

if not defined SETTING_VALUE if exist "%MC_ENV%" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%PRIMARY_NAME%=" "%MC_ENV%" 2^>nul') do (
    set "SETTING_VALUE=%%B"
  )
)

if not defined SETTING_VALUE (
  if exist "%MC_ENV_LOCAL%" (
    for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%LEGACY_NAME%=" "%MC_ENV_LOCAL%" 2^>nul') do (
      set "SETTING_VALUE=%%B"
    )
  )
)

if not defined SETTING_VALUE if exist "%MC_ENV%" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%LEGACY_NAME%=" "%MC_ENV%" 2^>nul') do (
    set "SETTING_VALUE=%%B"
  )
)

if not defined SETTING_VALUE (
  set "SETTING_VALUE=%SETTING_DEFAULT%"
)

if defined SETTING_VALUE (
  set "SETTING_VALUE=!SETTING_VALUE:"=!"
  for /f "tokens=* delims= " %%V in ("!SETTING_VALUE!") do set "SETTING_VALUE=%%V"
)

set "%TARGET_NAME%=%SETTING_VALUE%"
exit /b 0

:load_setting
set "SETTING_NAME=%~1"
set "SETTING_DEFAULT=%~2"
set "SETTING_VALUE="

if exist "%MC_ENV_LOCAL%" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%SETTING_NAME%=" "%MC_ENV_LOCAL%" 2^>nul') do (
    set "SETTING_VALUE=%%B"
  )
)

if not defined SETTING_VALUE if exist "%MC_ENV%" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i /c:"^%SETTING_NAME%=" "%MC_ENV%" 2^>nul') do (
    set "SETTING_VALUE=%%B"
  )
)

if defined SETTING_VALUE (
  set "SETTING_VALUE=!SETTING_VALUE:"=!"
  for /f "tokens=* delims= " %%V in ("!SETTING_VALUE!") do set "SETTING_VALUE=%%V"
  for /f "tokens=* delims= " %%V in ("!SETTING_VALUE!") do set "%SETTING_NAME%=%%V"
) else (
  set "%SETTING_NAME%=%SETTING_DEFAULT%"
)

exit /b 0

:maybe_start_ollama
set "START_OLLAMA=0"
echo %LLM_BASE_URL% | findstr /i /c:"127.0.0.1:11434" /c:"localhost:11434" >nul
if not errorlevel 1 set "START_OLLAMA=1"

if "%START_OLLAMA%"=="0" exit /b 0

where ollama >nul 2>nul
if errorlevel 1 (
  echo [WARN] Ollama was not found in PATH. Start it manually if needed.
  exit /b 0
)

call :tcp_probe %LLM_BASE_URL% OLLAMA_UP
if "%OLLAMA_UP%"=="1" (
  echo Ollama is already reachable at %LLM_BASE_URL%.
  exit /b 0
)

echo Starting Ollama...
start "Ollama" cmd /k "ollama serve"
timeout /t 2 /nobreak >nul
exit /b 0

:maybe_start_local_tts
if /i "%LOCAL_TTS_PROVIDER%"=="irodori-tts" (
  call :maybe_start_irodori_tts
  exit /b 0
)
if /i "%LOCAL_TTS_PROVIDER%"=="style-bert-vits2" (
  call :maybe_start_style_bert_vits2
  exit /b 0
)
exit /b 0

:maybe_start_irodori_tts
call :tcp_probe %LOCAL_TTS_BASEURL% LOCAL_TTS_UP
if "%LOCAL_TTS_UP%"=="1" (
  echo Irodori-TTS is already reachable at %LOCAL_TTS_BASEURL%.
  exit /b 0
)

if defined IRODORI_TTS_SERVER_CMD (
  echo Starting Irodori-TTS from IRODORI_TTS_SERVER_CMD...
  start "Irodori-TTS" cmd /k "%IRODORI_TTS_SERVER_CMD%"
  timeout /t 2 /nobreak >nul
  call :wait_for_tcp %LOCAL_TTS_BASEURL% LOCAL_TTS_UP 30
  exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
  call :extract_host_port %LOCAL_TTS_BASEURL%
  if exist "%ROOT%\tools\irodori-tts-server.py" (
    echo Starting Irodori-TTS from tools\irodori-tts-server.py...
    start "Irodori-TTS" cmd /k "python ""%ROOT%\tools\irodori-tts-server.py"" --host !EXTRACTED_HOST! --port !EXTRACTED_PORT!"
    timeout /t 2 /nobreak >nul
    call :wait_for_tcp %LOCAL_TTS_BASEURL% LOCAL_TTS_UP 30
    exit /b 0
  )
)

echo [WARN] Could not auto-start Irodori-TTS.
echo [WARN] Set IRODORI_TTS_SERVER_CMD in services\minecraft\.env.local if needed.
exit /b 0

:maybe_start_style_bert_vits2
if /i not "%LOCAL_TTS_PROVIDER%"=="style-bert-vits2" exit /b 0

call :tcp_probe %LOCAL_TTS_BASEURL% LOCAL_TTS_UP
if "%LOCAL_TTS_UP%"=="1" (
  echo Style-Bert-VITS2 is already reachable at %LOCAL_TTS_BASEURL%.
  exit /b 0
)

if defined STYLE_BERT_VITS2_SERVER_CMD (
  echo Starting Style-Bert-VITS2 from STYLE_BERT_VITS2_SERVER_CMD...
  start "Style-Bert-VITS2" cmd /k "%STYLE_BERT_VITS2_SERVER_CMD%"
  timeout /t 2 /nobreak >nul
  call :wait_for_tcp %LOCAL_TTS_BASEURL% LOCAL_TTS_UP 15
  exit /b 0
)

where style-bert-vits2-server >nul 2>nul
if not errorlevel 1 (
  echo Starting Style-Bert-VITS2 from style-bert-vits2-server...
  start "Style-Bert-VITS2" cmd /k "style-bert-vits2-server"
  timeout /t 2 /nobreak >nul
  call :wait_for_tcp %LOCAL_TTS_BASEURL% LOCAL_TTS_UP 15
  exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
  python -c "import style_bert_vits2" >nul 2>nul
  if not errorlevel 1 (
    call :extract_host_port %LOCAL_TTS_BASEURL%
    echo Starting Style-Bert-VITS2 from python module...
    start "Style-Bert-VITS2" cmd /k "python -m style_bert_vits2.server --host !EXTRACTED_HOST! --port !EXTRACTED_PORT!"
    timeout /t 2 /nobreak >nul
    call :wait_for_tcp %LOCAL_TTS_BASEURL% LOCAL_TTS_UP 15
    exit /b 0
  )
)

echo [WARN] Could not auto-start Style-Bert-VITS2.
echo [WARN] Set STYLE_BERT_VITS2_SERVER_CMD in services\minecraft\.env.local if needed.
exit /b 0

:tcp_probe
set "PROBE_URL=%~1"
set "%~2=0"
for /f %%S in ('powershell -NoProfile -Command "try { $u=[uri]$env:PROBE_URL; $tcp=New-Object Net.Sockets.TcpClient; $iar=$tcp.BeginConnect($u.Host,$u.Port,$null,$null); if(-not $iar.AsyncWaitHandle.WaitOne(1200)) { $tcp.Close(); 0 } else { $tcp.EndConnect($iar); $tcp.Close(); 1 } } catch { 0 }"') do (
  set "%~2=%%S"
)
exit /b 0

:wait_for_tcp
set "WAIT_URL=%~1"
set "%~2=0"
set "WAIT_SECONDS=%~3"
if not defined WAIT_SECONDS set "WAIT_SECONDS=10"
for /l %%I in (1,1,%WAIT_SECONDS%) do (
  call :tcp_probe %WAIT_URL% %~2
  call set "WAIT_STATE=%%%~2%%"
  if "!WAIT_STATE!"=="1" exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 0

:extract_host_port
set "EXTRACTED_HOST=127.0.0.1"
set "EXTRACTED_PORT=5000"
set "PROBE_URL=%~1"
for /f %%H in ('powershell -NoProfile -Command "try { ([uri]$env:PROBE_URL).Host } catch { '127.0.0.1' }"') do set "EXTRACTED_HOST=%%H"
for /f %%P in ('powershell -NoProfile -Command "try { $p=([uri]$env:PROBE_URL).Port; if ($p -gt 0) { $p } else { 5000 } } catch { 5000 }"') do set "EXTRACTED_PORT=%%P"
exit /b 0
