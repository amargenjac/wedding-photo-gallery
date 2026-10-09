@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js from https://nodejs.org and then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing the album service...
  call npm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)
node server.js
pause
