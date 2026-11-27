@echo off
title BunkerPlex - compilazione APK
cd /d "%~dp0..\.."

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop non e' avviato. Aprilo e riprova.
  pause
  exit /b 1
)

echo Compilo l'app Android (telefono e TV) dentro Docker.
echo La prima volta scarica gli strumenti Android: 5-10 minuti.
echo.
docker build --output "type=local,dest=android/out" android
if errorlevel 1 (
  echo.
  echo Compilazione non riuscita: leggi il messaggio qui sopra.
  pause
  exit /b 1
)

if not exist apk mkdir apk
copy /y "android\out\BunkerPlex.apk" "apk\BunkerPlex.apk" >nul
rem La vecchia app TV nativa non c'e' piu': le TV usano la stessa app del telefono
if exist "apk\BunkerPlexTV.apk" del "apk\BunkerPlexTV.apk"

rem La chiave di firma va conservata: serve per installare gli aggiornamenti
rem sopra la versione gia' presente sulla TV.
if not exist "android\keystore" mkdir "android\keystore"
if not exist "android\keystore\bunkerplex.jks" copy "android\out\keystore\bunkerplex.jks" "android\keystore\bunkerplex.jks" >nul

echo.
echo Fatto: apk\BunkerPlex.apk
echo Se l'app e' gia' sulla TV (dalla versione 1.3): al prossimo avvio propone
echo da sola l'aggiornamento. Altrimenti usa "Installa su TV.bat" qui accanto.
pause
