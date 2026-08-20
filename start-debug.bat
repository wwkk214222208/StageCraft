@echo off
setlocal
cd /d "%~dp0"
set "RP_LOG_MODEL_FINAL_CONTENT=1"
set "EFFECTIVE_PORT=%PORT%"
if not defined EFFECTIVE_PORT set "EFFECTIVE_PORT=8787"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%EFFECTIVE_PORT%" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>nul
wsl.exe -d Ubuntu -e bash -lc "pkill -f 'experimental-strip-types src/server.ts' 2>/dev/null; true" >nul 2>nul
echo Character Tavern debug mode.
echo Final provider message content will be printed below.
echo Hidden reasoning fields are not logged.
echo.
node --experimental-strip-types src/server.ts
pause
