@echo off
rem Avvia BunkerPlex su questo PC. Tutto il lavoro lo fa strumenti\Avvia.ps1:
rem accende Docker se e' spento, trova il catalogo anche se il disco ha cambiato
rem lettera, collega tutti i dischi (anche quelli esterni) e accende il server.
rem Il blocco tra parentesi viene letto tutto prima di partire: cosi' questo file
rem puo' essere sostituito da un aggiornamento mentre e' in esecuzione.
title BunkerPlex
cd /d "%~dp0.."
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\strumenti\Avvia.ps1"
  if errorlevel 1 if not defined FRANCOPLEX_NO_PAUSE (
    echo.
    echo BunkerPlex non e' partito: leggi il messaggio qui sopra.
    pause
  )
  exit /b
)
