@echo off
setlocal
title Close Character Tavern
set "PORT=8787"

echo Stopping Character Tavern in WSL...
wsl.exe -d Ubuntu -e bash -lc "pkill -f 'experimental-strip-types src/server.ts' && echo WSL instance stopped || echo No WSL instance running"

echo Checking for a Windows instance on port %PORT%...
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  taskkill /PID %%P /F >nul 2>nul
)
if defined FOUND (
  echo Windows instance stopped on port %PORT%.
) else (
  echo No Windows instance on port %PORT%.
)
timeout /t 2 >nul
exit /b 0
