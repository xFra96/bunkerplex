@echo off
rem Scarica da GitHub l'ultima versione di BunkerPlex (programma e app per la TV).
rem Il lavoro lo fa strumenti\Aggiorna.ps1. Catalogo e impostazioni non si toccano.
rem Il blocco tra parentesi viene letto tutto prima di partire: cosi' questo file
rem puo' essere sostituito dall'aggiornamento mentre e' in esecuzione.
title BunkerPlex - aggiornamento
cd /d "%~dp0"
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0strumenti\Aggiorna.ps1"
  echo.
  pause
  exit /b
)
