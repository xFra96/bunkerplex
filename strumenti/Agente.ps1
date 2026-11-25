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
#     racconto completo in strumenti\aggiornamento.log;
#   - quando il server lascia strumenti\richiesta-cestino.json (un doppione da
#     togliere, scelto da chi gestisce il server) sposta quel video nel Cestino
#     di Windows, da cui si puo' sempre recuperare, e scrive l'esito in
#     strumenti\esito-cestino.json.
#
#
# Segue anche i dischi del PC: Docker Desktop vede da solo solo quelli che
# c'erano quando si e' acceso. Quando colleghi un disco (anche USB) l'aiutante
# lo collega a Docker in pochi secondi e il server lo vede subito (la cartella
# dei dischi e' collegata con la propagazione "rslave", vedi Installa.ps1);
# quando lo stacchi lo scollega, cosi' alla prossima volta si ricollega pulito.
# Se torna il disco su cui sta BunkerPlex stesso, riaccende il server.
#
# Lo accende "Installa BunkerPlex.bat" e parte da solo all'accesso a Windows
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
$trashRequest = Join-Path $here 'richiesta-cestino.json'
$trashResult = Join-Path $here 'esito-cestino.json'

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
    $env:BUNKERPLEX_AUTO = '1'
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

# ---------------------------------------------------------------- cestino

# Solo video, solo su un disco fisso (i dischi rimovibili non hanno il Cestino:
# il file sparirebbe per sempre) e mai dentro la cartella di BunkerPlex
$videoExt = '\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|mts|webm|mpg|mpeg|flv|ogv|3gp|vob|divx|xvid)$'

function Run-Trash {
    $id = ''
    $files = @()
    try {
        $req = Get-Content -LiteralPath $trashRequest -Raw | ConvertFrom-Json
        $id = "$($req.id)"
        $files = @($req.files)
    } catch { }
    Remove-Item -LiteralPath $trashRequest -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName Microsoft.VisualBasic
    $msg = ''
    $done = @()
    foreach ($f in $files) {
        $p = "$f"
        if ($p -notmatch '^[A-Za-z]:\\' -or $p -notmatch $videoExt -or $p.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            $msg = "Non tocco questo file: $p"; break
        }
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $msg = "Il file non c'e' piu': $p"; break }
        try {
            $drive = New-Object System.IO.DriveInfo ($p.Substring(0, 1))
            if ($drive.DriveType -ne 'Fixed') { $msg = "Il disco $($p.Substring(0, 2)) non ha il Cestino: elimina il file a mano"; break }
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
            $done += $p
        } catch {
            $msg = "Non riesco a spostarlo nel Cestino: $($_.Exception.Message)"; break
        }
    }
    Write-Json $trashResult ([ordered]@{ id = $id; ok = (-not $msg); message = $msg; done = $done; at = (Now) })
}

# ---------------------------------------------------------------- dischi

$homeDrive = if ($root -match '^([A-Za-z]):') { $Matches[1].ToLower() } else { '' }
$lastDrives = ''
$lastSync = 0

function Docker-Up { return [bool](Get-Process 'com.docker.backend' -ErrorAction SilentlyContinue) }

# Lettere di Windows: quelle con dati (dischi interni, USB, chiavette) e tutte quelle presenti
function Windows-Drives {
    $all = @(); $data = @()
    foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
        $l = $d.Name.Substring(0, 1).ToLower()
        $all += $l
        try { if ($d.IsReady -and $d.DriveType -in 'Fixed', 'Removable') { $data += $l } } catch { }
    }
    return @{ all = $all; data = ($data | Sort-Object -Unique) }
}

function Has-Files($letter) {
    try { return [bool](Get-ChildItem -LiteralPath "${letter}:\" -Force -ErrorAction Stop | Select-Object -First 1) }
    catch { return $false }
}

# --exec: il comando va a sh cosi' com'e', senza passare dalla shell della macchina
function In-Vm($script) { return @(wsl.exe -d docker-desktop --exec sh -c $script 2>$null) }

# Dischi collegati nella macchina di Docker: lettera e se si legge ("c 1", "e 0")
function Vm-Drives {
    $out = @{}
    # Niente virgolette doppie: PowerShell 5 non le passa intatte a wsl.exe
    $lines = In-Vm 'for m in $(grep -o '' /mnt/host/[a-z] '' /proc/mounts | sort -u); do l=${m#/mnt/host/}; if ls -A $m 2>/dev/null | head -n 1 | grep -q .; then echo $l 1; else echo $l 0; fi; done'
    foreach ($line in $lines) {
        if ("$line" -match '^([a-z]) ([01])$') { $out[$Matches[1]] = $Matches[2] -eq '1' }
    }
    return $out
}

function Sync-Drives($force) {
    if (-not (Docker-Up)) { return }
    $win = Windows-Drives
    $key = $win.data -join ''
    if (-not $force -and $key -eq $script:lastDrives -and (Now) - $script:lastSync -lt 60) { return }
    $vm = Vm-Drives
    if (-not $vm.Count) { return }          # Docker non ancora pronto: si riprova
    $script:lastDrives = $key
    $script:lastSync = Now
    $restart = $false
    foreach ($l in $win.data) {
        $mounted = $vm.ContainsKey($l)
        if ($mounted -and ($vm[$l] -or -not (Has-Files $l))) { continue }
        # Nuovo, oppure collegato ma illeggibile (disco staccato e ricollegato): si (ri)collega
        $m = "/mnt/host/$l"
        In-Vm "umount -l $m 2>/dev/null; mkdir -p $m; mount -t drvfs $($l.ToUpper()): $m -o rw" | Out-Null
        if ($l -eq $homeDrive) { $restart = $true }
    }
    foreach ($l in @($vm.Keys)) {
        if ($win.all -notcontains $l) { In-Vm "umount -l /mnt/host/$l 2>/dev/null" | Out-Null }   # staccato
    }
    # Il disco di BunkerPlex era sparito: il server va riacceso per ritrovare il catalogo
    if ($restart) { docker restart bunkerplex 2>$null | Out-Null }
}

$startHash = Self-Hash
$lastBeat = 0
try {
    while ($true) {
        # Disco scollegato o cartella spostata: non c'e' piu' niente da fare qui
        if (-not (Test-Path -LiteralPath $updater)) { break }
        if ((Now) - $lastBeat -ge 30) { Beat; $lastBeat = Now }
        try { Sync-Drives $false } catch { }

        if (Test-Path -LiteralPath $trashRequest) {
            try { Run-Trash } catch { }
        }

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
