@echo off
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "%ROOT%golden.ps1"
) else (
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "%ROOT%golden.ps1" -DeckPath "%~f1"
)
exit /b %ERRORLEVEL%
