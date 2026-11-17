@echo off
rem Installa BunkerPlex su questo PC: e' l'unico file da lanciare, una volta sola.
rem Tutto il lavoro lo fa strumenti\Installa.ps1: installa e accende Docker Desktop,
rem lo fa partire all'accesso a Windows, collega a Docker tutti i dischi (anche
rem quelli esterni, pure quelli collegati dopo) e accende il server.
rem Da li' in poi BunkerPlex lo tiene acceso Docker, anche dopo un riavvio del PC.
rem Si puo' rilanciare quando si vuole: rimette a posto quello che manca.
rem Il blocco tra parentesi viene letto tutto prima di partire: cosi' questo file
rem puo' essere sostituito da un aggiornamento mentre e' in esecuzione.
title BunkerPlex - installazione
cd /d "%~dp0.."
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\strumenti\Installa.ps1"
  if errorlevel 1 if not defined FRANCOPLEX_NO_PAUSE (
    echo.
    echo Installazione non riuscita: leggi il messaggio qui sopra.
    pause
  )
  exit /b
)
