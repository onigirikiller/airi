@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "ROOT=%cd%"
if not defined VIEWER_PORT set "VIEWER_PORT=3000"
if not defined VIEWER_HUD_PORT set /a VIEWER_HUD_PORT=VIEWER_PORT+1
if not defined MONITOR_PORT set "MONITOR_PORT=3002"
set "COMMON_NODE_OPTIONS=--dns-result-order=ipv4first --use-system-ca"
set "LOCAL_TTS_PROVIDER=irodori-tts"
set "LOCAL_TTS_BASEURL=http://127.0.0.1:5000"
set "STYLE_BERT_VITS2_SERVER_CMD="
set "IRODORI_TTS_SERVER_CMD="

if exist "%ROOT%\services\minecraft\.env.local" (
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i "^[ ]*LOCAL_TTS_PROVIDER=" "%ROOT%\services\minecraft\.env.local" 2^>nul') do (
    set "LOCAL_TTS_PROVIDER_RAW=%%B"
  )
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i "^[ ]*LOCAL_TTS_BASEURL=" "%ROOT%\services\minecraft\.env.local" 2^>nul') do (
    set "LOCAL_TTS_BASEURL_RAW=%%B"
  )
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i "^[ ]*STYLE_BERT_VITS2_SERVER_CMD=" "%ROOT%\services\minecraft\.env.local" 2^>nul') do (
    set "STYLE_BERT_VITS2_SERVER_CMD_RAW=%%B"
  )
  for /f "tokens=1,* delims==" %%A in ('findstr /r /i "^[ ]*IRODORI_TTS_SERVER_CMD=" "%ROOT%\services\minecraft\.env.local" 2^>nul') do (
    set "IRODORI_TTS_SERVER_CMD_RAW=%%B"
  )
)
if defined LOCAL_TTS_PROVIDER_RAW (
  set "LOCAL_TTS_PROVIDER=!LOCAL_TTS_PROVIDER_RAW:"=!"
  for /f "tokens=* delims= " %%M in ("!LOCAL_TTS_PROVIDER!") do set "LOCAL_TTS_PROVIDER=%%M"
)
if defined LOCAL_TTS_BASEURL_RAW (
  set "LOCAL_TTS_BASEURL=!LOCAL_TTS_BASEURL_RAW:"=!"
  for /f "tokens=* delims= " %%M in ("!LOCAL_TTS_BASEURL!") do set "LOCAL_TTS_BASEURL=%%M"
)
if defined STYLE_BERT_VITS2_SERVER_CMD_RAW (
  set "STYLE_BERT_VITS2_SERVER_CMD=!STYLE_BERT_VITS2_SERVER_CMD_RAW:"=!"
  for /f "tokens=* delims= " %%M in ("!STYLE_BERT_VITS2_SERVER_CMD!") do set "STYLE_BERT_VITS2_SERVER_CMD=%%M"
)
if defined IRODORI_TTS_SERVER_CMD_RAW (
  set "IRODORI_TTS_SERVER_CMD=!IRODORI_TTS_SERVER_CMD_RAW:"=!"
  for /f "tokens=* delims= " %%M in ("!IRODORI_TTS_SERVER_CMD!") do set "IRODORI_TTS_SERVER_CMD=%%M"
)

set "INVALID_VIEWER="
for /f "delims=0123456789" %%A in ("%VIEWER_PORT%") do set "INVALID_VIEWER=1"
if defined INVALID_VIEWER set "VIEWER_PORT=3000"
if %VIEWER_PORT% LSS 1 set "VIEWER_PORT=3000"
if %VIEWER_PORT% GTR 65535 set "VIEWER_PORT=3000"

set "INVALID_VIEWER_HUD="
for /f "delims=0123456789" %%A in ("%VIEWER_HUD_PORT%") do set "INVALID_VIEWER_HUD=1"
if defined INVALID_VIEWER_HUD set /a VIEWER_HUD_PORT=VIEWER_PORT+1
if %VIEWER_HUD_PORT% LSS 1 set /a VIEWER_HUD_PORT=VIEWER_PORT+1
if %VIEWER_HUD_PORT% GTR 65535 set /a VIEWER_HUD_PORT=VIEWER_PORT+1

echo ============================================
echo AIRI Minecraft Launcher
echo ============================================
echo Enter your Minecraft LAN port. Example: 57685
echo.

:ask_port
set "LAN_PORT="
set /p "LAN_PORT=LAN port > "

if not defined LAN_PORT (
  echo [ERROR] Please enter a port number.
  echo.
  goto ask_port
)

set "INVALID="
for /f "delims=0123456789" %%A in ("%LAN_PORT%") do set "INVALID=1"
if defined INVALID (
  echo [ERROR] Port must be numeric.
  echo.
  goto ask_port
)

if %LAN_PORT% LSS 1 (
  echo [ERROR] Port must be greater than or equal to 1.
  echo.
  goto ask_port
)

if %LAN_PORT% GTR 65535 (
  echo [ERROR] Port must be less than or equal to 65535.
  echo.
  goto ask_port
)

if /i "%~1"=="--dry-run" (
  echo.
echo [DRY-RUN] BOT_PORT=%LAN_PORT%
  echo [DRY-RUN] cd /d "%ROOT%" ^&^& set NODE_OPTIONS=%COMMON_NODE_OPTIONS% ^&^& pnpm -F @proj-airi/server-runtime dev
  echo [DRY-RUN] cd /d "%ROOT%" ^&^& set NODE_OPTIONS=%COMMON_NODE_OPTIONS% ^&^& pnpm -F @proj-airi/stage-web dev
  echo [DRY-RUN] cd /d "%ROOT%" ^&^& set NODE_OPTIONS=%COMMON_NODE_OPTIONS% ^&^& set BOT_PORT=%LAN_PORT% ^&^& set VIEWER_PORT=%VIEWER_PORT% ^&^& set VIEWER_HUD_PORT=%VIEWER_HUD_PORT% ^&^& set MONITOR_ENABLED=true ^&^& set MONITOR_PORT=%MONITOR_PORT% ^&^& pnpm -F @proj-airi/minecraft-bot dev
  echo [DRY-RUN] start "" "http://localhost:%VIEWER_PORT%/"
  echo [DRY-RUN] start "" "http://localhost:%VIEWER_HUD_PORT%/"
  echo [DRY-RUN] start "" "http://localhost:%MONITOR_PORT%/"
  goto :eof
)

echo.
echo Root path: "%ROOT%"
if not exist "%ROOT%\package.json" (
  echo [ERROR] Root path is invalid: "%ROOT%"
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found in PATH.
  echo Run this first: corepack enable ^&^& corepack prepare pnpm@latest --activate
  exit /b 1
)

if /i "%LOCAL_TTS_PROVIDER%"=="irodori-tts" (
  echo Starting Irodori-TTS...
  set "IRODORI_STARTED=0"
  set "IRODORI_HOST=127.0.0.1"
  set "IRODORI_PORT=5000"
  for /f %%H in ('powershell -NoProfile -Command "try { ([uri]'%LOCAL_TTS_BASEURL%').Host } catch { '127.0.0.1' }"') do set "IRODORI_HOST=%%H"
  for /f %%P in ('powershell -NoProfile -Command "try { $p = ([uri]'%LOCAL_TTS_BASEURL%').Port; if ($p -gt 0) { $p } else { 5000 } } catch { 5000 }"') do set "IRODORI_PORT=%%P"
  set "IRODORI_ALREADY=0"
  for /f %%S in ('powershell -NoProfile -Command "try { $tcp=New-Object Net.Sockets.TcpClient; $iar=$tcp.BeginConnect('!IRODORI_HOST!',!IRODORI_PORT!,$null,$null); if(-not $iar.AsyncWaitHandle.WaitOne(1200)) { $tcp.Close(); 0 } else { $tcp.EndConnect($iar); $tcp.Close(); 1 } } catch { 0 }"') do set "IRODORI_ALREADY=%%S"
  if "!IRODORI_ALREADY!"=="1" (
    echo Irodori-TTS is already running at %LOCAL_TTS_BASEURL%
    set "IRODORI_STARTED=1"
  )

  if defined IRODORI_TTS_SERVER_CMD (
    if "!IRODORI_STARTED!"=="0" (
      start "Irodori-TTS" cmd /k "%IRODORI_TTS_SERVER_CMD%"
      set "IRODORI_STARTED=1"
      timeout /t 2 /nobreak >nul
    )
  )
  if "!IRODORI_STARTED!"=="0" (
    where python >nul 2>nul
    if not errorlevel 1 (
      if exist "%ROOT%\tools\irodori-tts-server.py" (
        start "Irodori-TTS" cmd /k "python ""%ROOT%\tools\irodori-tts-server.py"" --host !IRODORI_HOST! --port !IRODORI_PORT!"
        set "IRODORI_STARTED=1"
        timeout /t 2 /nobreak >nul
      )
    )
  )
  if "!IRODORI_STARTED!"=="0" (
    echo [WARN] Could not auto-start Irodori-TTS.
    echo [WARN] Set IRODORI_TTS_SERVER_CMD in services\minecraft\.env.local and run again.
  )
)

if /i "%LOCAL_TTS_PROVIDER%"=="style-bert-vits2" (
  echo Starting Style-Bert-VITS2...
  set "SBV2_STARTED=0"
  set "SBV2_HOST=127.0.0.1"
  set "SBV2_PORT=5000"
  for /f %%H in ('powershell -NoProfile -Command "try { ([uri]'%LOCAL_TTS_BASEURL%').Host } catch { '127.0.0.1' }"') do set "SBV2_HOST=%%H"
  for /f %%P in ('powershell -NoProfile -Command "try { $p = ([uri]'%LOCAL_TTS_BASEURL%').Port; if ($p -gt 0) { $p } else { 5000 } } catch { 5000 }"') do set "SBV2_PORT=%%P"
  set "SBV2_ALREADY=0"
  for /f %%S in ('powershell -NoProfile -Command "try { $tcp=New-Object Net.Sockets.TcpClient; $iar=$tcp.BeginConnect('!SBV2_HOST!',!SBV2_PORT!,$null,$null); if(-not $iar.AsyncWaitHandle.WaitOne(1200)) { $tcp.Close(); 0 } else { $tcp.EndConnect($iar); $tcp.Close(); 1 } } catch { 0 }"') do set "SBV2_ALREADY=%%S"
  if "!SBV2_ALREADY!"=="1" (
    echo Style-Bert-VITS2 is already running at %LOCAL_TTS_BASEURL%
    set "SBV2_STARTED=1"
  )

  if defined STYLE_BERT_VITS2_SERVER_CMD (
    if "!SBV2_STARTED!"=="0" (
      start "Style-Bert-VITS2" cmd /k "%STYLE_BERT_VITS2_SERVER_CMD%"
      set "SBV2_STARTED=1"
      timeout /t 2 /nobreak >nul
    )
  )
  if "!SBV2_STARTED!"=="0" (
    where style-bert-vits2-server >nul 2>nul
    if not errorlevel 1 (
      start "Style-Bert-VITS2" cmd /k "style-bert-vits2-server"
      set "SBV2_STARTED=1"
      timeout /t 2 /nobreak >nul
    )
  )
  if "!SBV2_STARTED!"=="0" (
    where python >nul 2>nul
    if not errorlevel 1 (
      python -c "import style_bert_vits2" >nul 2>nul
      if not errorlevel 1 (
        start "Style-Bert-VITS2" cmd /k "python -m style_bert_vits2.server --host !SBV2_HOST! --port !SBV2_PORT!"
        set "SBV2_STARTED=1"
        timeout /t 2 /nobreak >nul
      )
    )
  )
  if "!SBV2_STARTED!"=="0" (
    echo [WARN] Could not auto-start Style-Bert-VITS2.
    echo [WARN] Set STYLE_BERT_VITS2_SERVER_CMD in services\minecraft\.env.local and run again.
  )
)

echo.
echo Starting AIRI Runtime...
start "AIRI Runtime" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && pnpm -F @proj-airi/server-runtime dev"
timeout /t 2 /nobreak >nul

echo Starting Stage Web UI...
start "AIRI Stage Web" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && pnpm -F @proj-airi/stage-web dev"
timeout /t 2 /nobreak >nul

echo Starting Minecraft Bot (BOT_PORT=%LAN_PORT%)...
start "AIRI Minecraft Bot" cmd /k "cd /d ""%ROOT%"" && set NODE_OPTIONS=%COMMON_NODE_OPTIONS% && set BOT_PORT=%LAN_PORT% && set VIEWER_PORT=%VIEWER_PORT% && set VIEWER_HUD_PORT=%VIEWER_HUD_PORT% && set MONITOR_ENABLED=true && set MONITOR_PORT=%MONITOR_PORT% && pnpm -F @proj-airi/minecraft-bot dev"
timeout /t 3 /nobreak >nul

echo Opening AI Viewer...
start "" "http://localhost:%VIEWER_PORT%/"
echo Opening AI HUD Viewer...
start "" "http://localhost:%VIEWER_HUD_PORT%/"
echo Opening Monitor Dashboard...
start "" "http://localhost:%MONITOR_PORT%/"

echo.
echo Launched.
echo - Runtime : ws://localhost:6121/ws
echo - UI      : http://localhost:5173/
echo - Viewer  : http://localhost:%VIEWER_PORT%/
echo - HUD     : http://localhost:%VIEWER_HUD_PORT%/
echo - Monitor : http://localhost:%MONITOR_PORT%/
echo.
echo Close each terminal window to stop services.

endlocal
