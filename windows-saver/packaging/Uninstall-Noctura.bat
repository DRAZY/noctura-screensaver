@echo off
REM ============================================================================
REM  Noctura Screen Saver - Uninstaller
REM  Removes %WINDIR%\System32\Noctura.scr. Self-elevates to administrator.
REM ============================================================================
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)

set "DST=%WINDIR%\System32\Noctura.scr"

if exist "%DST%" (
    del /F /Q "%DST%"
    echo Noctura removed.
) else (
    echo Noctura was not installed ^(nothing to remove^).
)

echo.
echo If "Noctura" was your active screen saver, open Screen Saver settings
echo and pick a different one.
pause
endlocal
