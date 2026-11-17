@echo off
title BunkerPlex - installazione sulla TV
cd /d "%~dp0..\.."

if not exist "apk\FrenkPlex.apk" (
  echo Manca apk\FrenkPlex.apk: avvia prima "Compila APK.bat".
  pause
  exit /b 1
)

set "ADB=adb"
where adb >nul 2>&1
if errorlevel 1 set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not "%ADB%"=="adb" if not exist "%ADB%" (
  echo Su questo PC non c'e' "adb".
  echo Usa uno degli altri metodi descritti in README.md ^(chiavetta USB o app Downloader^).
  pause
  exit /b 1
)

echo Sulla TV: Impostazioni - Sistema - Informazioni, premi 7 volte su "Build"
echo per attivare le Opzioni sviluppatore, poi attiva "Debug USB" / "Debug di rete".
echo L'indirizzo IP della TV e' in Impostazioni - Rete.
echo.
set /p TVIP=Indirizzo IP della TV (es. 192.168.1.50):
if "%TVIP%"=="" exit /b 1

"%ADB%" connect %TVIP%:5555
echo.
echo Se sulla TV compare una richiesta di autorizzazione, accettala e premi un tasto qui.
pause >nul
"%ADB%" -s %TVIP%:5555 install -r "apk\FrenkPlex.apk"
echo.
"%ADB%" disconnect %TVIP%:5555 >nul
pause
