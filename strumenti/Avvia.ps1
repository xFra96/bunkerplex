# Nome vecchio di Installa.ps1: lo chiamano ancora gli aggiornamenti partiti da
# una versione precedente al cambio di nome. Le loro impostazioni arrivano con
# il nome vecchio (FRANCOPLEX_*): si passano a Installa.ps1 con quello nuovo,
# altrimenti l'installazione lanciata dall'aiutante aspetterebbe un INVIO.
foreach ($n in 'AUTO', 'NO_UPDATE', 'NO_PAUSE', 'NO_BROWSER', 'PULL') {
    $old = [Environment]::GetEnvironmentVariable("FRANCOPLEX_$n")
    if ($old) { [Environment]::SetEnvironmentVariable("BUNKERPLEX_$n", $old) }
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Installa.ps1')
exit $LASTEXITCODE
