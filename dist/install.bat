@echo off
rem Double-click shim for install.ps1 -- runs the real installer and keeps
rem this window open afterward so you can read the output (success or error).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
