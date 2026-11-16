# FrenkPlex - avvio. Lo lancia "Avvia FrenkPlex.bat": non serve aprirlo a mano.
#
# Fa tutto da solo, su qualsiasi PC con Docker Desktop:
#   1. trova Docker e, se e' spento, lo accende e aspetta che sia pronto;
#   2. prepara il catalogo (la cartella "data" qui accanto);
#   3. collega al server tutti i dischi del PC, interni ed esterni;
#   4. accende il server e controlla che i dischi si vedano davvero;
#      se un disco esterno risulta vuoto lo ricollega e, se serve, riavvia Docker.
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$Host.UI.RawUI.WindowTitle = 'FrenkPlex'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Stop-Here($text) {
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Yellow
    foreach ($line in $text) { Write-Host " $line" -ForegroundColor Yellow }
    Write-Host '============================================================' -ForegroundColor Yellow
    exit 1
}

function Ask($question) {
    $answer = Read-Host "$question [S/N]"
    return $answer -match '^\s*[sSyY]'
}

function Docker-Ready {
    docker info 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Find-DockerDesktop {
    $places = @()
    $cli = Get-Command docker -ErrorAction SilentlyContinue
    if ($cli) {
        # ...\resources\bin\docker.exe -> ...\Docker Desktop.exe
        $places += Join-Path (Split-Path (Split-Path (Split-Path $cli.Source))) 'Docker Desktop.exe'
    }
    $places += "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    $places += "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
    $places += "$env:LOCALAPPDATA\Docker\Docker Desktop.exe"
    foreach ($p in $places) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
    return $null
}

function Wait-Docker($seconds) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) {
        if (Docker-Ready) { Write-Host ''; return $true }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 3
    }
    Write-Host ''
    return $false
}

function Restart-Docker($desktop) {
    Say 'Riavvio Docker Desktop: ci vuole un minuto...'
    docker desktop restart 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        wsl.exe --terminate docker-desktop 2>$null | Out-Null
        if ($desktop) { Start-Process -FilePath $desktop }
    }
    Start-Sleep -Seconds 5
    return (Wait-Docker 240)
}

# Le unita' del PC che contengono dati: dischi interni, SSD/dischi USB, chiavette.
function Get-Drives {
    [System.IO.DriveInfo]::GetDrives() |
        Where-Object { $_.DriveType -in 'Fixed', 'Removable' -and $_.IsReady } |
        ForEach-Object { $_.Name.Substring(0, 1).ToUpper() } | Sort-Object -Unique
}

# Docker collega da solo soltanto i dischi presenti quando si e' acceso: quelli
# esterni (USB) vanno collegati a mano alla sua macchina virtuale, altrimenti
# nel server risultano vuoti. 'force': lo rifa' anche se sembra gia' collegato.
function Mount-Drive($letter, $writable, $force) {
    $l = $letter.ToLower()
    $m = "/mnt/host/$l"
    $opt = if ($writable) { 'rw' } else { 'ro' }
    $mount = "mkdir -p $m; mount -t drvfs ${letter}: $m -o $opt"
    if ($force) {
        $script = "umount -l $m 2>/dev/null; $mount"
    } elseif ($writable) {
        $script = "if mountpoint -q $m; then grep -q ' $m 9p rw' /proc/mounts || { umount -l $m 2>/dev/null; $mount; }; else $mount; fi"
    } else {
        $script = "mountpoint -q $m || { $mount; }"
    }
    wsl.exe -d docker-desktop sh -c $script 2>$null | Out-Null
}

function Has-Files($letter) {
    try { return [bool](Get-ChildItem -LiteralPath "${letter}:\" -Force -ErrorAction Stop | Select-Object -First 1) }
    catch { return $false }
}

function Seen-By-Server($letter) {
    $first = docker exec francoplex sh -c "ls -A /host/$letter 2>/dev/null | head -n 1" 2>$null
    return [bool]$first
}

function Catalog-Seen {
    docker exec francoplex test -f /data/.francoplex 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Start-Server($build) {
    # Un contenitore rimasto da un'altra copia della cartella terrebbe occupati nome e porta
    docker rm -f francoplex 2>$null | Out-Null
    if ($build) { docker compose up -d --build --force-recreate }
    else { docker compose up -d --no-build --force-recreate }
    return $LASTEXITCODE -eq 0
}

# ---------------------------------------------------------------- 0. Aggiornamenti
# Un controllo veloce su GitHub (strumenti\Aggiorna.ps1). Senza Internet o senza
# accesso al repository si prosegue in silenzio con la versione che c'e'.

$updater = Join-Path $PSScriptRoot 'Aggiorna.ps1'
if (-not $env:FRANCOPLEX_NO_UPDATE -and (Test-Path -LiteralPath $updater)) {
    $news = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $updater -Check 2>$null)
    $found = $LASTEXITCODE
    if ($found -eq 10) {
        Say ''
        foreach ($line in $news) { Say $line Cyan }
        if ($env:FRANCOPLEX_NO_PAUSE) {
            Say 'Per installarlo: "Aggiorna FrenkPlex.bat".'
        } elseif (Ask 'Lo installo adesso?') {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $updater -NoRestart
            # Si riparte da capo: questo stesso file puo' essere appena cambiato
            $env:FRANCOPLEX_NO_UPDATE = '1'
            & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
            exit $LASTEXITCODE
        }
    } elseif ($found -eq 2) {
        Say 'Aggiornamenti: questo PC non ha ancora l''accesso a GitHub (lancia "Aggiorna FrenkPlex.bat").' DarkGray
    }
}

# ---------------------------------------------------------------- 1. Docker

$desktop = Find-DockerDesktop
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and $desktop) {
    $env:Path += ';' + (Join-Path (Split-Path $desktop) 'resources\bin')
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Say 'Su questo PC non c''e'' Docker Desktop: FrenkPlex ne ha bisogno.' Yellow
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask 'Vuoi che lo installi adesso?')) {
        winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
        Stop-Here @('Finita l''installazione riavvia il PC, apri Docker Desktop una volta',
                    '(accetta le condizioni) e poi rilancia "Avvia FrenkPlex.bat".')
    }
    Stop-Here @('Installa Docker Desktop da https://www.docker.com/products/docker-desktop/',
                'poi rilancia "Avvia FrenkPlex.bat".')
}

if (-not (Docker-Ready)) {
    if (-not $desktop) {
        Stop-Here @('Docker non e'' avviato e non trovo Docker Desktop per accenderlo.',
                    'Aprilo a mano, aspetta che sia pronto e rilancia questo file.')
    }
    Say 'Docker Desktop e'' spento: lo accendo e aspetto che sia pronto...'
    Start-Process -FilePath $desktop
    if (-not (Wait-Docker 300)) {
        Stop-Here @('Docker Desktop non e'' partito in tempo.',
                    'Se e'' la prima volta su questo PC, aprilo e completa la sua configurazione',
                    '(condizioni d''uso, eventuale riavvio), poi rilancia questo file.')
    }
}

$os = (docker info --format '{{.OSType}}' 2>$null | Out-String).Trim()
if ($os -and $os -ne 'linux') {
    Stop-Here @('Docker e'' impostato sui "contenitori Windows".',
                'Clic destro sull''icona di Docker vicino all''orologio,',
                'scegli "Switch to Linux containers" e rilancia questo file.')
}
$kernel = (docker info --format '{{.KernelVersion}}' 2>$null | Out-String).Trim()
$wsl = $kernel -match 'microsoft|WSL'

# ---------------------------------------------------------------- 2. Catalogo
# Il catalogo (elenco dei film, schede, locandine, visti) sta sempre nella
# cartella "data" qui accanto: viaggia insieme a FrenkPlex, qualunque lettera
# abbia il disco su questo PC. Se non c'e' ancora, nasce vuoto.

if (-not (Test-Path -LiteralPath 'apk')) { New-Item -ItemType Directory -Path 'apk' | Out-Null }

$data = Join-Path $root 'data'
if (-not (Test-Path -LiteralPath $data -PathType Container)) {
    New-Item -ItemType Directory -Path $data -Force | Out-Null
}

# Segnaposto: dice al server che questa e' davvero la cartella del catalogo e non
# una cartella vuota creata da Docker perche' il disco mancava.
$marker = Join-Path $data '.francoplex'
try {
    [System.IO.File]::WriteAllText($marker, "Catalogo di FrenkPlex: non cancellare questo file.`r`n")
} catch {
    Stop-Here @("Non riesco a scrivere in $data", 'Il disco e'' protetto da scrittura o pieno?')
}
$dataDrive = if ($data -match '^([A-Za-z]):') { $Matches[1].ToUpper() } else { '' }

# ---------------------------------------------------------------- 3. Dischi

$drives = @(Get-Drives)
if ($wsl) {
    foreach ($d in $drives) { Mount-Drive $d ($d -eq $dataDrive) $false }
}

function Write-Override($list) {
    $lines = @('# Creato da "Avvia FrenkPlex.bat" a ogni avvio: non modificarlo a mano.',
               'services:', '  francoplex:', '    volumes:')
    foreach ($d in $list) {
        $lines += '      - type: bind'
        $lines += "        source: `"${d}:/`""
        $lines += "        target: /host/$d"
        $lines += '        read_only: true'
    }
    if (-not $list) { $lines += '      - ./apk:/apk:ro' }
    [System.IO.File]::WriteAllLines((Join-Path $root 'docker-compose.override.yml'), $lines)
}
Write-Override $drives

# ---------------------------------------------------------------- 4. Server

Say ''
Say 'Avvio FrenkPlex... la prima volta su un PC ci vuole qualche minuto.'
Say ("Dischi collegati: " + (($drives | ForEach-Object { "${_}:" }) -join ' '))
Say "Catalogo: $data"
Say ''

docker compose build
$built = $LASTEXITCODE -eq 0
if (-not $built) {
    docker image inspect francoplex-server 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Here @('Non sono riuscito a preparare il server: leggi il messaggio qui sopra.',
                    'La prima volta su un PC serve la connessione a Internet.')
    }
    Say 'Non riesco ad aggiornare il server (manca Internet?): uso la versione gia'' pronta su questo PC.' Yellow
}
if (-not (Start-Server $false)) {
    Stop-Here @('Il server non e'' partito: leggi il messaggio qui sopra.',
                'Se parla della porta 32500, un altro programma la sta usando.')
}
Start-Sleep -Seconds 2

# Controllo: il server vede davvero il catalogo e i dischi? Un disco esterno
# collegato male risulta vuoto. In quel caso: lo si ricollega; se non basta,
# si riavvia Docker (alla riaccensione vede tutti i dischi collegati al PC).
function Find-Missing {
    $bad = @()
    foreach ($d in $drives) {
        if ((Has-Files $d) -and -not (Seen-By-Server $d)) { $bad += $d }
    }
    if ($dataDrive -and ($bad -notcontains $dataDrive) -and -not (Catalog-Seen)) { $bad += $dataDrive }
    return $bad
}

$missing = @(Find-Missing)
if ($missing -and $wsl) {
    Say ("Il server non vede bene: " + (($missing | ForEach-Object { "${_}:" }) -join ' ') + " - lo ricollego...") Yellow
    foreach ($d in $missing) { Mount-Drive $d ($d -eq $dataDrive) $true }
    Start-Server $false | Out-Null
    Start-Sleep -Seconds 2
    $missing = @(Find-Missing)
}
if ($missing -and $desktop) {
    Say ("Ancora niente per: " + (($missing | ForEach-Object { "${_}:" }) -join ' ')) Yellow
    if (Restart-Docker $desktop) {
        if ($wsl) { foreach ($d in $drives) { Mount-Drive $d ($d -eq $dataDrive) $false } }
        Start-Server $false | Out-Null
        Start-Sleep -Seconds 2
        $missing = @(Find-Missing)
    }
}
if ($missing) {
    Say ''
    Say ("ATTENZIONE: il server non riesce a leggere: " + (($missing | ForEach-Object { "${_}:" }) -join ' ')) Yellow
    if ($wsl) {
        Say 'Prova a scollegare e ricollegare il disco e rilancia questo file.' Yellow
    } else {
        Say 'Questo Docker non usa WSL 2: apri Docker Desktop, Settings - Resources -' Yellow
        Say 'File sharing, aggiungi quei dischi e rilancia questo file.' Yellow
        Say '(Oppure attiva "Use the WSL 2 based engine" in Settings - General.)' Yellow
    }
}

$ip = ''
try {
    $ip = (Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway } |
           Select-Object -First 1).IPv4Address.IPAddress | Select-Object -First 1
} catch { }

Say ''
Say '============================================================' Green
Say ' FrenkPlex e'' acceso.' Green
Say ''
Say ' Dal PC:      http://localhost:32500'
Say ' Dalla TV:    l''app trova il server da sola.'
if ($ip) {
    Say '              Se chiede l''indirizzo, scrivi questo:'
    Say "                 $ip"
}
Say ''
Say ' Le raccolte e le cartelle dei video si scelgono dall''app:'
Say ' "Aggiungi raccolta" nel menu a sinistra.'
Say ' Se colleghi un altro disco, rilancia questo file.'
Say '============================================================' Green
Say ''
if (-not $env:FRANCOPLEX_NO_BROWSER) { Start-Process 'http://localhost:32500' }
if (-not $env:FRANCOPLEX_NO_PAUSE) { Read-Host 'Premi INVIO per chiudere questa finestra (FrenkPlex resta acceso)' | Out-Null }
