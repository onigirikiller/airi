@echo off
setlocal

echo ============================================
echo  AIRI MC Bridge - Fabric Mod Setup
echo ============================================
echo.

rem --- Check JAVA_HOME ---
if not defined JAVA_HOME (
    rem Try Android Studio JBR
    if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" (
        set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
        echo Using Android Studio JBR: %JAVA_HOME%
    ) else (
        echo ERROR: JAVA_HOME not set and Android Studio JBR not found.
        echo Please install JDK 21 and set JAVA_HOME.
        exit /b 1
    )
)

echo JAVA_HOME: %JAVA_HOME%
"%JAVA_HOME%\bin\java" -version 2>&1

echo.
echo --- Step 1: Download Gradle Wrapper ---
if not exist "gradle\wrapper\gradle-wrapper.jar" (
    echo Downloading Gradle Wrapper...
    powershell -Command "Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.10-bin.zip' -OutFile 'gradle-8.10-bin.zip'"
    echo Extracting...
    powershell -Command "Expand-Archive -Path 'gradle-8.10-bin.zip' -DestinationPath 'gradle-tmp' -Force"
    copy "gradle-tmp\gradle-8.10\lib\gradle-wrapper-*.jar" "gradle\wrapper\gradle-wrapper.jar" >nul
    del gradle-8.10-bin.zip
    rmdir /s /q gradle-tmp
    echo Gradle Wrapper downloaded.
) else (
    echo Gradle Wrapper already present.
)

echo.
echo --- Step 2: Build Mod ---
call gradlew.bat build
if %ERRORLEVEL% neq 0 (
    echo BUILD FAILED
    exit /b 1
)

echo.
echo --- Step 3: Copy to Minecraft mods folder ---
set "MODS_DIR=%APPDATA%\.minecraft\mods"
if not exist "%MODS_DIR%" (
    mkdir "%MODS_DIR%"
)

for %%f in (build\libs\airi-mcbridge-*.jar) do (
    if not "%%f"=="build\libs\airi-mcbridge-*-sources.jar" (
        copy "%%f" "%MODS_DIR%\" /Y
        echo Copied %%f to %MODS_DIR%
    )
)

echo.
echo ============================================
echo  Build complete!
echo  Mod installed to: %MODS_DIR%
echo.
echo  Next steps:
echo  1. Install Fabric Loader for 1.20.4 (if not already)
echo     https://fabricmc.net/use/installer/
echo  2. Download Fabric API and place in mods folder
echo  3. (Optional) Download Baritone for pathfinding
echo  4. Launch Minecraft with Fabric profile
echo  5. Start Node.js controller with FABRIC_BRIDGE_ENABLED=true
echo ============================================

endlocal
