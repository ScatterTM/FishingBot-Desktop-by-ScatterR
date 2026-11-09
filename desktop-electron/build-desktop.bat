@echo off
rem Builds the Electron desktop app into ..\dist\Fishingbot.exe (called by build.bat).
rem Run it alone too: desktop-electron\build-desktop.bat
rem Needs Node.js 22 or newer and Internet access (Electron, electron-builder and rcedit are installed by npm once).
rem The icon is written into the EXE by rcedit, which needs no admin rights or Developer Mode.
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0.."
set "DIST=%ROOT%\dist"

where node >nul 2>nul || (echo Node.js 22 or newer is required to build the desktop app. & goto :fail)

node "%ROOT%\scripts\stamp-version.cjs" || (echo Could not stamp the version from VERSION. & goto :fail)
echo [1/3] Installing desktop app dependencies...
call npm install || goto :fail

echo [2/3] Building Fishingbot.exe with Electron...
call node sync-shared.js || goto :fail
if exist release rmdir /s /q release
call npx electron-builder --win dir --x64 --publish never
if errorlevel 1 (
  echo electron-builder failed. Read the messages above, fix the cause, then run this file again.
  goto :fail
)
if not exist "release\win-unpacked\Fishingbot.exe" (echo release\win-unpacked\Fishingbot.exe was not produced. & goto :fail)

rem electron-builder cannot set the EXE icon without the code-signing tools (which need Developer Mode),
rem so rcedit writes it. Explorer, the Start Menu and shortcuts all read the icon from this EXE.
echo Setting the Fishingbot icon on Fishingbot.exe...
call node set-icon.js "release\win-unpacked\Fishingbot.exe" "renderer\assets\app.ico"
if errorlevel 1 (echo Could not set the EXE icon with rcedit. Check the Internet connection and run this file again. & goto :fail)

echo [3/3] Copying the app into dist...
if not exist "%DIST%" mkdir "%DIST%"
robocopy "release\win-unpacked" "%DIST%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo Copying the desktop app to dist failed. & goto :fail)
if not exist "%DIST%\Fishingbot.exe" (echo dist\Fishingbot.exe is missing after the copy. & goto :fail)
rem A plain icon file next to the app. Shortcuts use it, so they show the icon even if the EXE icon is missing.
copy /y "renderer\assets\app.ico" "%DIST%\app.ico" >nul
if errorlevel 1 (echo Copying app.ico to dist failed. & goto :fail)
rem Ship the OBS script beside the app when this build script is run without build.bat.
if not exist "%DIST%\obs-scripts" mkdir "%DIST%\obs-scripts"
copy /y "%ROOT%\obs-scripts\fishingbot-autostart.lua" "%DIST%\obs-scripts\" >nul
if errorlevel 1 (echo Copying OBS auto-start script failed. & goto :fail)
if not exist "%DIST%\lib" mkdir "%DIST%\lib"
copy /y "%ROOT%\lib\db-manager-worker.mjs" "%DIST%\lib\" >nul
if errorlevel 1 (echo Copying database worker failed. & goto :fail)
copy /y "%ROOT%\lib\db-import-worker.mjs" "%DIST%\lib\" >nul
if errorlevel 1 (echo Copying database import worker failed. & goto :fail)

echo Desktop app built: %DIST%\Fishingbot.exe
exit /b 0

:fail
echo.
echo DESKTOP APP BUILD FAILED. Read the message above, fix the cause, then run this file again.
if not defined FISHINGBOT_NO_PAUSE pause
exit /b 1
