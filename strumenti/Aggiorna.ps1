# FrenkPlex - aggiornamento da GitHub. Lo lancia "Aggiorna FrenkPlex.bat"
# (e "Avvia FrenkPlex.bat", che a ogni avvio controlla se c'e' qualcosa di nuovo).
#
# Scarica dal repository indicato in strumenti\aggiornamenti.json:
#   - i file del programma (server, script, sorgenti dell'app per la TV);
#   - l'APK per la TV gia' compilato (allegato alla release "app-tv").
# Non tocca mai: catalogo (data), .env, chiave di firma, token.
#
# Il repository puo' essere privato. L'accesso viene preso, nell'ordine, da:
#   1. variabile d'ambiente FRENKPLEX_GITHUB_TOKEN;
#   2. file strumenti\github-token.txt (un token di sola lettura);
#   3. GitHub CLI, se su questo PC e' installato e collegato (gh auth login).
# Non serve avere git installato.
#
#   -Check      controlla soltanto: esce con 10 se c'e' un aggiornamento,
#               0 se e' tutto aggiornato, 2 se manca l'accesso, 1 se non riesce.
#   -NoRestart  non propone di riavviare il server alla fine.
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

param([switch]$Check, [switch]$NoRestart)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$cfgFile = Join-Path $PSScriptRoot 'aggiornamenti.json'
$stateFile = Join-Path $PSScriptRoot 'versione.json'
$tokenFile = Join-Path $PSScriptRoot 'github-token.txt'
$apkFile = Join-Path $root 'apk\FrenkPlex.apk'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Ask($question) {
    $answer = Read-Host "$question [S/N]"
    return $answer -match '^\s*[sSyY]'
}

function Fail($lines, $code = 1) {
    if (-not $Check) {
        Write-Host ''
        foreach ($line in $lines) { Write-Host " $line" -ForegroundColor Yellow }
    }
    exit $code
}

# ------------------------------------------------------------ impostazioni

if (-not (Test-Path -LiteralPath $cfgFile)) { Fail @('Manca strumenti\aggiornamenti.json: non so da dove aggiornare.') }
try { $cfg = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json } catch { Fail @('strumenti\aggiornamenti.json non e'' leggibile.') }
$repo = "$($cfg.repo)".Trim()
$branch = if ($cfg.branch) { "$($cfg.branch)".Trim() } else { 'main' }
$apkTag = if ($cfg.apk_release) { "$($cfg.apk_release)".Trim() } else { 'app-tv' }
if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { Fail @('In strumenti\aggiornamenti.json manca "repo" (es. utente/FrenkPlex).') }

$state = $null
if (Test-Path -LiteralPath $stateFile) {
    try { $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { }
}

# ------------------------------------------------------------ accesso a GitHub

function Get-Token {
    if ($env:FRENKPLEX_GITHUB_TOKEN) { return $env:FRENKPLEX_GITHUB_TOKEN.Trim() }
    if (Test-Path -LiteralPath $tokenFile) {
        foreach ($line in Get-Content -LiteralPath $tokenFile) {
            $t = "$line".Trim()
            if ($t -and -not $t.StartsWith('#')) { return $t }
        }
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        try {
            $t = (& gh auth token 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $t) { return $t }
        } catch { }
    }
    return ''
}
$script:token = Get-Token

function Api($path, $accept = 'application/vnd.github+json', $outFile = $null) {
    $headers = @{ 'Accept' = $accept; 'X-GitHub-Api-Version' = '2022-11-28' }
    if ($script:token) { $headers['Authorization'] = "Bearer $script:token" }
    $url = "https://api.github.com/repos/$repo/$path"
    if ($outFile) {
        Invoke-WebRequest -Uri $url -Headers $headers -UserAgent 'FrenkPlex-updater' -UseBasicParsing `
            -OutFile $outFile -TimeoutSec 900 -ErrorAction Stop
    } else {
        $wait = if ($Check) { 8 } else { 30 }
        Invoke-RestMethod -Uri $url -Headers $headers -UserAgent 'FrenkPlex-updater' -UseBasicParsing `
            -TimeoutSec $wait -ErrorAction Stop
    }
}

function Http-Status($err) {
    try { return [int]$err.Exception.Response.StatusCode } catch { return 0 }
}

function Get-RemoteCommit {
    return (Api "commits/$branch" 'application/vnd.github.sha' | Out-String).Trim()
}

# Il repository privato risponde "non trovato" a chi non ha l'accesso.
$remoteSha = $null
for ($try = 0; $try -lt 2 -and -not $remoteSha; $try++) {
    try {
        $remoteSha = Get-RemoteCommit
    } catch {
        $status = Http-Status $_
        if ($status -notin 401, 403, 404) {
            Fail @('Non riesco a raggiungere GitHub: manca Internet?', "($($_.Exception.Message))")
        }
        if ($Check) { Write-Output 'ACCESSO'; exit 2 }
        if ($try -gt 0) { Fail @('GitHub rifiuta ancora l''accesso: controlla il token e riprova.') 2 }
        Say ''
        if ($script:token) {
            Say "GitHub non da' accesso a $repo con le credenziali di questo PC" Yellow
            Say '(token scaduto, oppure senza permesso su questo repository).' Yellow
        } else {
            Say "Il repository degli aggiornamenti ($repo) e' privato" Yellow
            Say 'e questo PC non ha ancora l''accesso.' Yellow
        }
        Say ''
        Say 'Incolla qui un token di GitHub di sola lettura (come crearlo: LEGGIMI.md,'
        Say 'capitolo "Aggiornamenti"). Resta salvato in strumenti\github-token.txt,'
        Say 'quindi sul disco esterno vale per tutti i PC. Oppure premi INVIO per uscire'
        Say 'e collega questo PC con GitHub CLI: gh auth login'
        $pasted = (Read-Host 'Token').Trim()
        if (-not $pasted) { exit 2 }
        [System.IO.File]::WriteAllText($tokenFile, "$pasted`r`n")
        $script:token = $pasted
    }
}
if ($remoteSha -notmatch '^[0-9a-f]{40}$') { Fail @('Risposta di GitHub non valida.') }

# ------------------------------------------------------------ cosa c'e' di nuovo

# Copia di sviluppo (cartella .git): i file li aggiorna git, non questo script,
# altrimenti git vedrebbe come "modificati a mano" tutti i file scaricati.
$gitCopy = Test-Path -LiteralPath (Join-Path $root '.git')
$haveGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

function Git { & git -c 'safe.directory=*' @args }

$codeUpdate = $false
if ($gitCopy) {
    if ($haveGit) {
        # Aggiornato (o piu' avanti) se il commit di GitHub e' gia' nella storia locale
        Git merge-base --is-ancestor $remoteSha HEAD 2>$null | Out-Null
        $codeUpdate = $LASTEXITCODE -ne 0
    }
} else {
    $codeUpdate = (-not $state) -or ($state.commit -ne $remoteSha)
}

function Get-ApkAsset {
    try { $release = Api "releases/tags/$apkTag" } catch { return $null }
    $asset = $release.assets | Where-Object { $_.name -eq 'FrenkPlex.apk' } | Select-Object -First 1
    if (-not $asset) { return $null }
    if (Test-Path -LiteralPath $apkFile) {
        $mine = Get-Item -LiteralPath $apkFile
        $when = $asset.updated_at
        if ($when -isnot [DateTime]) {
            $when = [DateTime]::Parse("$when", [Globalization.CultureInfo]::InvariantCulture,
                                      [Globalization.DateTimeStyles]::RoundtripKind)
        }
        # Un APK compilato qui dopo l'ultima pubblicazione e' piu' nuovo: resta lui
        if ($mine.LastWriteTimeUtc -ge $when.ToUniversalTime()) { return $null }
        if ($asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
            if ((Get-FileHash -LiteralPath $apkFile -Algorithm SHA256).Hash -eq $Matches[1]) { return $null }
        } elseif ($mine.Length -eq $asset.size) {
            return $null
        }
    }
    return $asset
}
$apkAsset = Get-ApkAsset

if ($Check) {
    if ($codeUpdate -or $apkAsset) {
        $what = @()
        if ($codeUpdate) { $what += 'il programma' }
        if ($apkAsset) { $what += 'l''app per la TV' }
        Write-Output ("E' disponibile un aggiornamento di FrenkPlex (" + ($what -join ' e ') + ').')
        exit 10
    }
    exit 0
}

if (-not $codeUpdate -and -not $apkAsset) {
    Say ''
    Say 'FrenkPlex e'' gia'' aggiornato.' Green
    if ($gitCopy -and -not $haveGit) {
        Say '(Questa e'' la copia di sviluppo e su questo PC non c''e'' git: ho controllato solo l''app per la TV.)'
    }
    exit 0
}

# ------------------------------------------------------------ file del programma

# Mai toccati, qualunque cosa arrivi da GitHub
function Is-Protected($rel) {
    $r = $rel -replace '/', '\'
    if ($r -match '(^|\\)\.\.(\\|$)' -or [System.IO.Path]::IsPathRooted($r)) { return $true }
    if ($r -match '^(data|apk|\.git|android\\out|android\\keystore)(\\|$)') { return $true }
    return $r -in '.env', 'docker-compose.override.yml', 'strumenti\github-token.txt', 'strumenti\versione.json'
}

function Same-File($a, $b) {
    if ((Get-Item -LiteralPath $a).Length -ne (Get-Item -LiteralPath $b).Length) { return $false }
    return (Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash
}

function Update-Files {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('frenkplex-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Say 'Scarico il programma da GitHub...'
        $zip = Join-Path $tmp 'p.zip'
        Api "zipball/$remoteSha" 'application/vnd.github+json' $zip
        Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -Force -ErrorAction Stop
        $src = (Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1).FullName
        if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src 'strumenti\Aggiorna.ps1'))) {
            throw 'il pacchetto scaricato non sembra FrenkPlex'
        }

        $files = @()
        $changed = 0
        foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File -Force) {
            $rel = $f.FullName.Substring($src.Length + 1)
            if (Is-Protected $rel) { continue }
            $files += $rel
            $dest = Join-Path $root $rel
            if ((Test-Path -LiteralPath $dest -PathType Leaf) -and (Same-File $f.FullName $dest)) { continue }
            $dir = Split-Path -Parent $dest
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Copy-Item -LiteralPath $f.FullName -Destination $dest -Force -ErrorAction Stop
            $changed++
        }

        # File che nella versione nuova non esistono piu': si tolgono solo quelli
        # arrivati da un aggiornamento precedente, mai file tuoi.
        $removed = 0
        if ($state -and $state.files) {
            foreach ($old in $state.files) {
                if (($files -contains $old) -or (Is-Protected $old)) { continue }
                $gone = Join-Path $root $old
                if (Test-Path -LiteralPath $gone -PathType Leaf) {
                    Remove-Item -LiteralPath $gone -Force -ErrorAction SilentlyContinue
                    $removed++
                }
            }
        }

        if (-not (Test-Path -LiteralPath '.env') -and (Test-Path -LiteralPath '.env.example')) {
            Copy-Item -LiteralPath '.env.example' -Destination '.env'
        }

        $new = [ordered]@{ commit = $remoteSha; date = (Get-Date).ToString('s'); files = $files }
        [System.IO.File]::WriteAllText($stateFile, ($new | ConvertTo-Json -Depth 3))
        Say "Programma aggiornato: $changed file nuovi o cambiati, $removed tolti." Green
        return $true
    } catch {
        Say "Aggiornamento del programma non riuscito: $($_.Exception.Message)" Yellow
        Say 'Non e'' cambiato niente di importante: puoi riprovare quando vuoi.' Yellow
        return $false
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-Git {
    Say 'Questa e'' la copia di sviluppo: aggiorno con git...'
    Git pull --ff-only origin $branch
    if ($LASTEXITCODE -ne 0) {
        Say 'git non e'' riuscito ad aggiornare: ci sono modifiche locali non pubblicate' Yellow
        Say '(usa "Pubblica aggiornamento.bat") oppure manca l''accesso di git a GitHub.' Yellow
        return $false
    }
    return $true
}

function Update-Apk($asset) {
    Say 'Scarico l''app per la TV...'
    $part = "$apkFile.nuovo"
    try {
        $dir = Split-Path -Parent $apkFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Api "releases/assets/$($asset.id)" 'application/octet-stream' $part
        $got = Get-Item -LiteralPath $part
        $head = New-Object byte[] 2
        $stream = [System.IO.File]::OpenRead($part)
        try { $stream.Read($head, 0, 2) | Out-Null } finally { $stream.Dispose() }
        if ($got.Length -ne $asset.size -or $head[0] -ne 0x50 -or $head[1] -ne 0x4B) { throw 'file scaricato a meta''' }
        Move-Item -LiteralPath $part -Destination $apkFile -Force -ErrorAction Stop
        Say 'App per la TV aggiornata: al prossimo avvio la TV propone da sola di installarla.' Green
        return $true
    } catch {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        Say "App per la TV non scaricata: $($_.Exception.Message)" Yellow
        return $false
    }
}

Say ''
$codeDone = $false
if ($codeUpdate) {
    if ($gitCopy) { $codeDone = Update-Git } else { $codeDone = Update-Files }
}
if ($apkAsset) { Update-Apk $apkAsset | Out-Null }

# Il server gira dentro Docker con i file vecchi finche' non viene riavviato.
if ($codeDone -and -not $NoRestart) {
    $running = ''
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $running = (docker ps --filter 'name=^francoplex$' --format '{{.Names}}' 2>$null | Out-String).Trim()
    }
    Say ''
    if ($running) {
        if (Ask 'FrenkPlex e'' acceso con la versione vecchia. Lo riavvio adesso?') {
            $env:FRANCOPLEX_NO_UPDATE = '1'
            & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Avvia.ps1')
            exit $LASTEXITCODE
        }
        Say 'La versione nuova parte al prossimo "Avvia FrenkPlex.bat".'
    } else {
        Say 'La versione nuova parte al prossimo "Avvia FrenkPlex.bat".'
    }
}
if ($codeUpdate -and -not $codeDone) { exit 1 }
exit 0
