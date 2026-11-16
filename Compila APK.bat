@echo off
title FrenkPlex - compilazione APK
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop non e' avviato. Aprilo e riprova.
  pause
  exit /b 1
)

echo Compilo l'app per la TV dentro Docker.
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
copy /y "android\out\FrenkPlex.apk" "apk\FrenkPlex.apk" >nul

rem La chiave di firma va conservata: serve per installare gli aggiornamenti
rem sopra la versione gia' presente sulla TV.
if not exist "android\keystore" mkdir "android\keystore"
if not exist "android\keystore\francoplex.jks" copy "android\out\keystore\francoplex.jks" "android\keystore\francoplex.jks" >nul

echo.
echo Fatto: apk\FrenkPlex.apk
echo Se l'app e' gia' sulla TV (dalla versione 1.3): al prossimo avvio propone
echo da sola l'aggiornamento. Altrimenti leggi LEGGIMI.md o usa "Installa su TV.bat".
pause
