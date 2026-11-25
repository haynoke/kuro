@echo off
title Kuro
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Kuro needs Node.js 22 or newer. Install it from https://nodejs.org/ and reopen this window.
  pause
  exit /b 1
)
if not exist config.json (
  echo Missing config.json. Open PowerShell in this folder and run:
  echo Copy-Item config.example.json config.json
  pause
  exit /b 1
)
node server.js
set "KURO_EXIT=%ERRORLEVEL%"
pause
exit /b %KURO_EXIT%
