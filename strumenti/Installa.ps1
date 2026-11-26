# BunkerPlex - installazione. La lancia "Installa BunkerPlex.bat": non serve aprirla a mano.
# La rilanciano anche gli aggiornamenti che devono ricostruire Docker (Aggiorna.ps1).
#
# Fa tutto da solo, su qualsiasi PC con Docker Desktop:
#   1. trova Docker (se manca propone di installarlo) e, se e' spento, lo accende;
#      poi lo fa partire da solo a ogni accesso a Windows;
#   2. prepara il catalogo (la cartella "data" qui accanto);
#   3. collega al server tutti i dischi del PC, interni ed esterni, una volta per
#      tutte: quelli collegati dopo compaiono da soli (li segue Agente.ps1);
#   4. accende il server e controlla che i dischi si vedano davvero;
#      se un disco esterno risulta vuoto lo ricollega e, se serve, riavvia Docker;
#   5. accende l'aiutante (Agente.ps1), che parte anche a ogni accesso a Windows.
# Da li' in poi BunkerPlex lo tiene acceso Docker (restart: unless-stopped).
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$Host.UI.RawUI.WindowTitle = 'BunkerPlex'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Stop-Here($text) {
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Yellow
    foreach ($line in $text) { Write-Host " $line" -ForegroundColor Yellow }
    Write-Host '============================================================' -ForegroundColor Yellow
    exit 1
}

function Ask($question) {
    if ($env:BUNKERPLEX_AUTO) { return $false }    # lanciato dall'aiutante: nessuno puo' rispondere
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

# Su alcuni Windows i "socket" che Docker Desktop lascia quando si spegne
# diventano illeggibili e alla riaccensione Docker si blocca con "The file cannot
# be accessed by the system". A Docker spento si tolgono; se non si riesce, si
# sposta da parte la cartella che li contiene: Docker la ricrea pulita.
function Clear-DockerSockets {
    if (Get-Process 'com.docker.backend' -ErrorAction SilentlyContinue) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($d in "$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine") {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $stuck = $false
        foreach ($f in Get-ChildItem -LiteralPath $d -Force -File -ErrorAction SilentlyContinue) {
            if (-not ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            try { [IO.File]::Delete($f.FullName) } catch { $stuck = $true }
        }
        if ($stuck) {
            try { [IO.Directory]::Move($d, "$d.vecchia-$stamp") } catch { }
        }
    }
}

function Restart-Docker($desktop) {
    Say 'Riavvio Docker Desktop: ci vuole un minuto...'
    docker desktop restart 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        wsl.exe --terminate docker-desktop 2>$null | Out-Null
        Clear-DockerSockets
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
    $l = $letter.ToLower()
    $first = docker exec bunkerplex sh -c "ls -A /host/$l 2>/dev/null | head -n 1" 2>$null
    return [bool]$first
}

function Catalog-Seen {
    docker exec bunkerplex test -f /data/.bunkerplex 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Start-Server($build) {
    # Un contenitore rimasto da un'altra copia della cartella terrebbe occupati nome e porta
    # (anche quello delle versioni precedenti, che si chiamava francoplex)
    docker rm -f bunkerplex francoplex 2>$null | Out-Null
    if ($build) { docker compose up -d --build --force-recreate }
    else { docker compose up -d --no-build --force-recreate }
    return $LASTEXITCODE -eq 0
}

# ---------------------------------------------------------------- 0. Aggiornamenti
# Un controllo veloce su GitHub (strumenti\Aggiorna.ps1). Senza Internet o senza
# accesso al repository si prosegue in silenzio con la versione che c'e'.

$updater = Join-Path $PSScriptRoot 'Aggiorna.ps1'
if (-not $env:BUNKERPLEX_NO_UPDATE -and (Test-Path -LiteralPath $updater)) {
    $news = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $updater -Check 2>$null)
    $found = $LASTEXITCODE
    if ($found -eq 10) {
        Say ''
        foreach ($line in $news) { Say $line Cyan }
        # Aggiornamento automatico (Impostazioni -> Aggiornamenti): si installa
        # senza chiedere. Se e' spento, si chiede (o si avvisa e basta).
        $autoUpdate = $true
        try {
            $cfgData = Get-Content -LiteralPath (Join-Path $root 'data\config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($cfgData.auto_update -eq $false) { $autoUpdate = $false }
        } catch { }
        $install = $autoUpdate
        if (-not $install) {
            if ($env:BUNKERPLEX_NO_PAUSE -or $env:BUNKERPLEX_AUTO) { Say 'Per installarlo: Impostazioni - Aggiornamenti, nell''app.' }
            else { $install = Ask 'Lo installo adesso?' }
        }
        if ($install) {
            Say 'Lo installo...' Cyan
            & powershell -NoProfile -ExecutionPolicy Bypass -File $updater -NoRestart
            # Si riparte da capo: questo stesso file puo' essere appena cambiato,
            # e l'immagine Docker si ricostruisce con i pacchetti nuovi
            $env:BUNKERPLEX_NO_UPDATE = '1'
            $env:BUNKERPLEX_PULL = '1'
            & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
            exit $LASTEXITCODE
        }
    } elseif ($found -eq 2) {
        Say 'Aggiornamenti: questo PC non ha ancora l''accesso a GitHub (Impostazioni - Aggiornamenti, nell''app).' DarkGray
    }
}

# ---------------------------------------------------------------- 1. Docker

$desktop = Find-DockerDesktop
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and $desktop) {
    $env:Path += ';' + (Join-Path (Split-Path $desktop) 'resources\bin')
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Say 'Su questo PC non c''e'' Docker Desktop: BunkerPlex ne ha bisogno.' Yellow
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask 'Vuoi che lo installi adesso?')) {
        winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
        Stop-Here @('Finita l''installazione riavvia il PC, apri Docker Desktop una volta',
                    '(accetta le condizioni) e poi rilancia "Installa BunkerPlex.bat".')
    }
    Stop-Here @('Installa Docker Desktop da https://www.docker.com/products/docker-desktop/',
                'poi rilancia "Installa BunkerPlex.bat".')
}

if (-not (Docker-Ready)) {
    if (-not $desktop) {
        Stop-Here @('Docker non e'' avviato e non trovo Docker Desktop per accenderlo.',
                    'Aprilo a mano, aspetta che sia pronto e rilancia questo file.')
    }
    Say 'Docker Desktop e'' spento: lo accendo e aspetto che sia pronto...'
    Clear-DockerSockets
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
# cartella "data" qui accanto: viaggia insieme a BunkerPlex, qualunque lettera
# abbia il disco su questo PC. Se non c'e' ancora, nasce vuoto.

if (-not (Test-Path -LiteralPath 'apk')) { New-Item -ItemType Directory -Path 'apk' | Out-Null }

$data = Join-Path $root 'data'
if (-not (Test-Path -LiteralPath $data -PathType Container)) {
    New-Item -ItemType Directory -Path $data -Force | Out-Null
}

# Segnaposto: dice al server che questa e' davvero la cartella del catalogo e non
# una cartella vuota creata da Docker perche' il disco mancava.
$marker = Join-Path $data '.bunkerplex'
try {
    [System.IO.File]::WriteAllText($marker, "Catalogo di BunkerPlex: non cancellare questo file.`r`n")
} catch {
    Stop-Here @("Non riesco a scrivere in $data", 'Il disco e'' protetto da scrittura o pieno?')
}
$dataDrive = if ($data -match '^([A-Za-z]):') { $Matches[1].ToUpper() } else { '' }

# ---------------------------------------------------------------- 3. Dischi

$drives = @(Get-Drives)
if ($wsl) {
    foreach ($d in $drives) { Mount-Drive $d ($d -eq $dataDrive) $false }
}

# Con WSL 2 (il caso normale) si collega una volta sola la cartella in cui Docker
# Desktop vede tutti i dischi di Windows (/mnt/host/c, /mnt/host/g, ...), con la
# propagazione "rslave": un disco che l'aiutante collega dopo (Agente.ps1) compare
# subito nel server, senza riavviarlo. Senza WSL 2 si collegano i dischi di adesso.
function Write-Override($list) {
    $lines = @('# Creato da "Installa BunkerPlex.bat": non modificarlo a mano.',
               'services:', '  bunkerplex:', '    volumes:')
    if ($wsl) {
        $lines += '      - type: bind'
        $lines += '        source: /mnt/host'
        $lines += '        target: /host'
        $lines += '        read_only: true'
        $lines += '        bind:'
        $lines += '          propagation: rslave'
    } else {
        foreach ($d in $list) {
            $lines += '      - type: bind'
            $lines += "        source: `"${d}:/`""
            $lines += "        target: /host/$($d.ToLower())"
            $lines += '        read_only: true'
        }
        if (-not $list) { $lines += '      - ./apk:/apk:ro' }
    }
    [System.IO.File]::WriteAllLines((Join-Path $root 'docker-compose.override.yml'), $lines)
}
Write-Override $drives

# Docker Desktop parte da solo all'accesso a Windows (e con lui BunkerPlex).
# Se l'ha gia' chiesto Docker Desktop stesso ("Start Docker Desktop when you sign
# in") non si aggiunge niente; altrimenti un collegamento in Esecuzione automatica.
if ($desktop) {
    try {
        $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $have = Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue
        if (-not $have.'Docker Desktop') {
            Set-ItemProperty -LiteralPath $run -Name 'BunkerPlex Docker' -Value "`"$desktop`"" -ErrorAction Stop
        }
    } catch { }
}

# ---------------------------------------------------------------- 4. Server

Say ''
Say 'Avvio BunkerPlex... la prima volta su un PC ci vuole qualche minuto.'
Say ("Dischi collegati: " + (($drives | ForEach-Object { "${_}:" }) -join ' '))
Say "Catalogo: $data"
Say ''

# L'impronta dei file del server va nel contenitore: cosi' Aggiorna.ps1 sa se
# il server acceso e' allineato a questi file (vedi Impronta.ps1).
. (Join-Path $PSScriptRoot 'Impronta.ps1')
$env:BUNKERPLEX_BUILD = Get-Impronta $root
# Indirizzo del PC in casa: dentro Docker il server non lo vede (serve al QR dell'app per il telefono)
try {
    $env:BUNKERPLEX_LAN_IP = (Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway } |
        Select-Object -First 1).IPv4Address.IPAddress | Select-Object -First 1
} catch { }
# Impronta della macchina: dentro Docker il server non la vede (riconosce una reinstallazione sullo stesso PC)
try {
    $env:BUNKERPLEX_MACHINE = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
} catch { }
# Indirizzo Tailscale (100.64.0.0/10), se c'e': gli amici entrano da li' e sul router non si apre nulla
try {
    $env:BUNKERPLEX_TAILSCALE_IP = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' } |
        Select-Object -First 1 -ExpandProperty IPAddress
} catch { }

# Dopo un aggiornamento si scarica anche l'immagine di base piu' recente
# (Python, ffmpeg): senza Internet si torna alla ricostruzione normale.
$built = $false
if ($env:BUNKERPLEX_PULL) {
    docker compose build --pull
    $built = $LASTEXITCODE -eq 0
}
if (-not $built) {
    docker compose build
    $built = $LASTEXITCODE -eq 0
}
if (-not $built) {
    docker image inspect bunkerplex-server 2>$null | Out-Null
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

# ---------------------------------------------------------------- 4b. Firewall
# TV e telefoni arrivano da fuori: il firewall di Windows deve lasciar entrare
# le porte 32500, 32501 e 32443 (anche con la rete impostata come "Pubblica").
# Firewall.ps1 lo controlla senza permessi; se serve sistemare chiede una volta
# il consenso di Windows. Lanciato dall'aiutante nessuno puo' rispondere: si
# rimanda alla prossima volta che si apre "Installa".

$firewall = Join-Path $PSScriptRoot 'Firewall.ps1'
if (Test-Path -LiteralPath $firewall) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $firewall -Check 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $env:BUNKERPLEX_AUTO) {
        Say 'Apro le porte di BunkerPlex nel firewall di Windows: conferma la richiesta di Windows.' Cyan
        $fwArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$firewall`""
        $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
        try {
            if ($admin) { & powershell -NoProfile -ExecutionPolicy Bypass -File $firewall | Out-Null }
            else { Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList $fwArgs -ErrorAction Stop }
        } catch { }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $firewall -Check 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Say 'Firewall a posto: TV e telefoni possono collegarsi.' Green }
        else {
            Say 'Il firewall non e'' stato aperto: TV e telefoni potrebbero non trovare il server.' Yellow
            Say 'Rilancia questo file e rispondi Si'' alla richiesta di Windows.' Yellow
        }
    }
}

# ---------------------------------------------------------------- 5. Aiutante aggiornamenti
# Agente.ps1 resta acceso nascosto: fa gli aggiornamenti chiesti dal server
# (dalla TV, dal telefono, dal browser o dal controllo automatico), compresa
# la ricostruzione di Docker. Parte anche da solo all'accesso a Windows.

$agent = Join-Path $PSScriptRoot 'Agente.ps1'
if (Test-Path -LiteralPath $agent) {
    $agentArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agent`""
    try {
        $startup = [Environment]::GetFolderPath('Startup')
        $link = Join-Path $startup 'BunkerPlex aggiornamenti.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $current = if (Test-Path -LiteralPath $link) { $shell.CreateShortcut($link) } else { $null }
        # Si riscrive solo se manca o punta a un'altra cartella (disco con un'altra lettera)
        if (-not $current -or $current.Arguments -ne $agentArgs) {
            $lnk = $shell.CreateShortcut($link)
            $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $lnk.Arguments = $agentArgs
            $lnk.WorkingDirectory = $PSScriptRoot
            $lnk.WindowStyle = 7
            $lnk.Description = 'BunkerPlex: aggiornamenti chiesti da TV e browser'
            $lnk.Save()
        }
    } catch { }
    # Ne gira uno solo: se e' gia' acceso, quello nuovo si chiude da solo
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList $agentArgs -ErrorAction SilentlyContinue
}

$ip = ''
try {
    $ip = (Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway } |
           Select-Object -First 1).IPv4Address.IPAddress | Select-Object -First 1
} catch { }

Say ''
Say '============================================================' Green
Say ' BunkerPlex e'' acceso.' Green
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
Say ''
Say ' Da adesso BunkerPlex lo tiene acceso Docker, anche dopo un riavvio'
Say ' del PC: non serve rilanciare niente. I dischi che colleghi dopo'
Say ' compaiono da soli. Per spegnerlo: Docker Desktop, Containers, Stop.'
Say '============================================================' Green
Say ''
if (-not $env:BUNKERPLEX_NO_BROWSER) { Start-Process 'http://localhost:32500' }
if (-not $env:BUNKERPLEX_NO_PAUSE) { Read-Host 'Premi INVIO per chiudere questa finestra (BunkerPlex resta acceso)' | Out-Null }
