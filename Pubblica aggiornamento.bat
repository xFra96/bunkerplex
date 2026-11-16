@echo off
rem Manda su GitHub le modifiche fatte a FrenkPlex su questo PC (e l'APK, se e'
rem stato ricompilato). Serve solo sul PC di sviluppo: richiede git e GitHub CLI.
title FrenkPlex - pubblicazione
cd /d "%~dp0"
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\Pubblica.ps1"
  echo.
  pause
  exit /b
)
