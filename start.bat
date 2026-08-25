@echo off
setlocal
cd /d "%~dp0"
set "PORT=8787"
set "RP_REMOTE=1"

REM Stop any existing instance (Windows + WSL) so two servers never share the DB.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>nul
wsl.exe -d Ubuntu -e bash -lc "pkill -f 'experimental-strip-types src/server.ts' 2>/dev/null; true" >nul 2>nul

echo Character Tavern (Windows native) starting on http://0.0.0.0:%PORT% (remote access enabled: local http://127.0.0.1:%PORT%, phone pairing uses LAN address)
node --experimental-strip-types src/server.ts
pause
