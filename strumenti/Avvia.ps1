# Nome vecchio di Installa.ps1: lo chiamano ancora gli aggiornamenti partiti da
# una versione precedente. Passa tutto a Installa.ps1.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Installa.ps1')
exit $LASTEXITCODE
