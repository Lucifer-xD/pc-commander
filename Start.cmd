@echo off
title PC Commander (quick tunnel)
cd /d "%~dp0"
REM Foreground run with a TEMPORARY public URL (prints it). Ctrl+C to stop.
REM For a permanent URL + auto-start, use scripts\install.ps1 + scripts\setup-domain.ps1.
node src\run.mjs
pause
