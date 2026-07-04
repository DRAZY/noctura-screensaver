@echo off
REM ============================================================================
REM  Noctura Screen Saver - Installer
REM  Copies the matching .scr into %WINDIR%\System32 (where Windows looks for
REM  screensavers) and opens the Screen Saver settings so you can select it.
REM  Requires administrator rights; it will self-elevate.
REM ============================================================================
setlocal

REM --- Elevate to admin if not already ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)

REM --- Pick the build that matches this PC's CPU ---
set "ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"

set "SRC=%~dp0Noctura-%ARCH%.scr"
set "DST=%WINDIR%\System32\Noctura.scr"

if not exist "%SRC%" (
    echo ERROR: Could not find "%SRC%".
    echo Make sure you run this from the folder that contains the .scr files.
    pause
    exit /b 1
)

echo Installing %ARCH% build...
copy /Y "%SRC%" "%DST%" >nul
if %errorlevel% neq 0 (
    echo ERROR: Copy failed.
    pause
    exit /b 1
)

echo.
echo Noctura installed to "%DST%".
echo Opening Screen Saver settings - pick "Noctura" from the dropdown,
echo then click Settings... to choose a scene and style.
echo.
rundll32.exe shell32.dll,Control_RunDLL desk.cpl,,1
endlocal
