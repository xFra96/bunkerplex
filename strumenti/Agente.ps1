# BunkerPlex - aiutante degli aggiornamenti. Gira nascosto sul PC del server.
#
# Il server sta dentro Docker: da li' puo' aggiornare i propri file, ma non
# ricostruire il contenitore (nuovi pacchetti, Dockerfile, docker-compose.yml)
# ne' aggiornare la copia di sviluppo con git. Questo aiutante fa da ponte:
#   - ogni 30 secondi scrive strumenti\agente.json ("ci sono");
#   - quando il server (chiesto da TV, telefono, browser o dal controllo
#     automatico) lascia strumenti\richiesta-aggiornamento.json, lancia
#     Aggiorna.ps1 -Auto: scarica le novita' e riallinea Docker;
#   - scrive com'e' andata in strumenti\esito-aggiornamento.json e il
#     racconto completo in strumenti\aggiornamento.log.
#
# Lo accende "Avvia BunkerPlex.bat" e parte da solo all'accesso a Windows
# (collegamento "BunkerPlex aggiornamenti" in Esecuzione automatica).
# Ne gira uno solo per PC. Si spegne da solo se il disco viene scollegato.
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$agentFile = Join-Path $here 'agente.json'
$requestFile = Join-Path $here 'richiesta-aggiornamento.json'
$resultFile = Join-Path $here 'esito-aggiornamento.json'
$logFile = Join-Path $here 'aggiornamento.log'
$updater = Join-Path $here 'Aggiorna.ps1'

$mutex = New-Object System.Threading.Mutex($false, 'Local\BunkerPlexAgente')
try { $mine = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $mine = $true }
if (-not $mine) { exit 0 }

function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Write-Json($path, $value) {
    $part = "$path.nuovo"
    [System.IO.File]::WriteAllText($part, ($value | ConvertTo-Json -Compress -Depth 3))
    Move-Item -LiteralPath $part -Destination $path -Force
}

function Beat {
    try { Write-Json $agentFile ([ordered]@{ pid = $PID; at = (Now); host = $env:COMPUTERNAME }) } catch { }
}

function Self-Hash {
    try { return (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash } catch { return '' }
}

# Le ultime righe che spiegano un errore, dal racconto dell'aggiornamento
function Last-Words {
    try {
        $lines = @(Get-Content -LiteralPath $logFile -ErrorAction Stop |
            ForEach-Object { "$_".Trim() } | Where-Object { $_ -and $_ -notmatch '^[=\-]+$' })
        return (($lines | Select-Object -Last 2) -join ' ')
    } catch { return '' }
}

function Run-Update($id) {
    Write-Json $resultFile ([ordered]@{ id = $id; phase = 'running'; ok = $false; message = ''; at = (Now) })
    $env:FRANCOPLEX_AUTO = '1'
    $code = 1
    $errFile = "$logFile.errori"
    try {
        # A parte e non in questo processo: intanto si continua a dire "ci sono",
        # anche durante una ricostruzione di Docker che dura minuti
        $p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError $errFile -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$updater`"", '-Auto')
        $null = $p.Handle     # senza questo ExitCode resta vuoto
        while (-not $p.HasExited) {
            Beat
            Start-Sleep -Seconds 5
        }
        $p.WaitForExit()
        $code = $p.ExitCode
        if ((Test-Path -LiteralPath $errFile) -and (Get-Item -LiteralPath $errFile).Length -gt 0) {
            Get-Content -LiteralPath $errFile | Add-Content -LiteralPath $logFile -ErrorAction SilentlyContinue
        }
    } catch {
        Add-Content -LiteralPath $logFile -Value "$($_.Exception.Message)" -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
    $ok = $code -eq 0
    $msg = ''
    if (-not $ok) {
        $msg = Last-Words
        if ($code -eq 2) { $msg = 'Questo PC non ha l''accesso al repository degli aggiornamenti.' }
        elseif ($code -eq 3) { $msg = 'C''e'' gia'' un aggiornamento in corso su questo PC.' }
        if (-not $msg) { $msg = 'Aggiornamento non riuscito sul PC: leggi strumenti\aggiornamento.log.' }
    }
    Write-Json $resultFile ([ordered]@{ id = $id; phase = 'done'; ok = $ok; message = $msg; at = (Now) })
}

$startHash = Self-Hash
$lastBeat = 0
try {
    while ($true) {
        # Disco scollegato o cartella spostata: non c'e' piu' niente da fare qui
        if (-not (Test-Path -LiteralPath $updater)) { break }
        if ((Now) - $lastBeat -ge 30) { Beat; $lastBeat = Now }

        if (Test-Path -LiteralPath $requestFile) {
            $id = ''
            try { $id = "$((Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json).id)" } catch { }
            Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
            if (-not $id) { $id = [Guid]::NewGuid().ToString('N') }
            Run-Update $id
            Beat; $lastBeat = Now
            # L'aggiornamento puo' aver cambiato questo stesso file: riparte la versione nuova
            if ((Self-Hash) -ne $startHash) { break }
        }
        Start-Sleep -Seconds 3
    }
} finally {
    $restart = (Test-Path -LiteralPath $PSCommandPath) -and ((Self-Hash) -ne $startHash)
    if (-not $restart) { Remove-Item -LiteralPath $agentFile -Force -ErrorAction SilentlyContinue }
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
    if ($restart) {
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            '-File', "`"$PSCommandPath`"")
    }
}
