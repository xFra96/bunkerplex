@echo off
setlocal
title BunkerPlex - installazione sulla TV Samsung
cd /d "%~dp0..\.."

rem L'app BunkerPlex per le TV Samsung (tizen/). Non serve per usare BunkerPlex su una
rem Samsung: basta il browser della TV. L'app aggiunge l'icona tra le App.
rem Serve Docker Desktop: l'installazione gira nell'immagine con Tizen Studio.

where docker >nul 2>&1
if errorlevel 1 (
  echo Serve Docker Desktop, che su questo PC non c'e'.
  pause
  exit /b 1
)

echo Sulla TV Samsung:
echo  1. apri App, poi scrivi 1 2 3 4 5 col telecomando ^(o il tasto 123^)
echo  2. accendi "Modalita' sviluppatore" e come IP del PC host scrivi quello di QUESTO PC
echo  3. spegni e riaccendi la TV
echo L'indirizzo IP della TV e' in Impostazioni - Generali - Rete - Stato della rete.
echo.
set /p TVIP=Indirizzo IP della TV (es. 192.168.1.50):
if "%TVIP%"=="" exit /b 1

set "CERTPW="
if not exist "tizen\certificati\author.p12" goto installa
if not exist "tizen\certificati\distributor.p12" goto installa
echo.
echo C'e' il certificato Samsung in tizen\certificati: l'app si firma con quello.
set /p CERTPW=Password del certificato:

:installa
echo.
if "%CERTPW%"=="" (
  docker run --rm --ulimit nofile=1024:65536 -v "%CD%\tizen:/bp:ro" --entrypoint /bin/bash ghcr.io/georift/install-jellyfin-tizen /bp/installa.sh %TVIP%
) else (
  docker run --rm --ulimit nofile=1024:65536 -v "%CD%\tizen:/bp:ro" -v "%CD%\tizen\certificati:/certificates:ro" --entrypoint /bin/bash ghcr.io/georift/install-jellyfin-tizen /bp/installa.sh %TVIP% "%CERTPW%"
)
echo.
pause
