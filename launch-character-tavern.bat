@echo off
setlocal
set "ROOT=%~dp0"
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%launch-character-tavern.ps1"
if errorlevel 1 pause
