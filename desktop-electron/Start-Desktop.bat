@echo off
rem Runs the Electron desktop app from the source folder (development). Keep this window open.
rem Needs Node.js 22.5 or newer. The server runs with your system Node.js.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js 22.5 or newer is required. Install it from https://nodejs.org & pause & exit /b 1)

if not exist node_modules\electron (
  echo Installing desktop app dependencies once...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)
call npm start
exit /b 0
