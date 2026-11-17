# BunkerPlex - pubblicazione su GitHub. Lo lancia strumenti\sviluppo\"Pubblica aggiornamento.bat".
# Serve solo sul PC dove modifichi BunkerPlex (con git e GitHub CLI installati):
#   1. salva le modifiche (commit) e le manda al repository (push);
#   2. se apk\BunkerPlex.apk e' cambiato, lo allega alla release "app-tv".
#      Con .github\workflows\apk.yml l'APK lo compila e lo allega GitHub da solo:
#      allora questo passo si salta e GitHub CLI non serve.
# Gli altri PC li ricevono da soli (controllo ogni 12 ore) o dall'app.
#
# Mai pubblicati (vedi .gitignore): catalogo, .env, chiave di firma, token.
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

param([string]$Message = '')

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($lines) {
    Write-Host ''
    foreach ($line in $lines) { Write-Host " $line" -ForegroundColor Yellow }
    exit 1
}
# "git.exe" e non "git": PowerShell non distingue maiuscole e minuscole, quindi
# una funzione di nome Git che chiama "git" richiamerebbe se stessa all'infinito.
function Git { & git.exe -c 'safe.directory=*' @args }

$ci = Test-Path -LiteralPath (Join-Path $root '.github\workflows\apk.yml')
foreach ($tool in @('git') + @(if (-not $ci) { 'gh' })) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail @("Su questo PC manca '$tool': serve per pubblicare.",
               'git: https://git-scm.com   GitHub CLI: https://cli.github.com')
    }
}
if (-not (Test-Path -LiteralPath '.git')) { Fail @('Questa cartella non e'' la copia di sviluppo (manca .git).') }

$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'aggiornamenti.json') -Raw | ConvertFrom-Json
$repo = "$($cfg.repo)".Trim()
$branch = if ($cfg.branch) { "$($cfg.branch)".Trim() } else { 'main' }
$apkTag = if ($cfg.apk_release) { "$($cfg.apk_release)".Trim() } else { 'app-tv' }
$apkFile = Join-Path $root 'apk\BunkerPlex.apk'

# ------------------------------------------------------------ 1. programma

Git add -A
$pending = @(Git status --porcelain)
if ($pending) {
    Say 'Modifiche da pubblicare:' Cyan
    Git status --short
    Say ''
    if (-not $Message) { $Message = (Read-Host 'Descrizione breve (INVIO = "Aggiornamento")').Trim() }
    if (-not $Message) { $Message = 'Aggiornamento ' + (Get-Date).ToString('yyyy-MM-dd HH:mm') }
    Git commit -q -m $Message
    if ($LASTEXITCODE -ne 0) { Fail @('Il salvataggio (commit) non e'' riuscito: leggi il messaggio qui sopra.') }
} else {
    Say 'Nessuna modifica nuova ai file del programma.'
}

Git push -q origin "HEAD:$branch"
if ($LASTEXITCODE -ne 0) { Fail @('Invio a GitHub non riuscito: leggi il messaggio qui sopra.') }
Say "Programma pubblicato su $repo." Green

# ------------------------------------------------------------ 2. app per la TV

if ($ci) {
    Say 'La release (BunkerPlex.zip e, se e'' cambiato android\, l''app per la TV) la aggiorna GitHub da sola'
    Say "in qualche minuto (avanzamento: https://github.com/$repo/actions)."
} elseif (Test-Path -LiteralPath $apkFile) {
    $mine = (Get-FileHash -LiteralPath $apkFile -Algorithm SHA256).Hash
    $size = (Get-Item -LiteralPath $apkFile).Length
    $release = $null
    $json = (& gh api "repos/$repo/releases/tags/$apkTag" 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and $json) { try { $release = $json | ConvertFrom-Json } catch { } }
    $asset = $null
    if ($release) { $asset = $release.assets | Where-Object { $_.name -eq 'BunkerPlex.apk' } | Select-Object -First 1 }

    $same = $false
    if ($asset) {
        if ($asset.digest -match '^sha256:([0-9a-fA-F]{64})$') { $same = $Matches[1] -eq $mine }
        else { $same = $asset.size -eq $size }
    }
    if ($same) {
        Say 'L''app per la TV su GitHub e'' gia'' questa.'
    } else {
        Say 'Carico l''app per la TV...'
        if ($release) {
            & gh release upload $apkTag $apkFile --clobber --repo $repo
        } else {
            & gh release create $apkTag $apkFile --repo $repo --title 'App per la TV' `
                --notes 'APK di BunkerPlex per Android TV, Google TV e Fire TV. Viene sostituito a ogni pubblicazione.'
        }
        if ($LASTEXITCODE -ne 0) { Fail @('Caricamento dell''APK non riuscito: leggi il messaggio qui sopra.') }
        Say 'App per la TV pubblicata.' Green
    }
} else {
    Say 'Nessun APK da pubblicare (apk\BunkerPlex.apk non c''e'').'
}

Say ''
Say 'Fatto. Gli altri PC lo ricevono da soli (o dall''app: Impostazioni - Aggiornamenti).' Green
