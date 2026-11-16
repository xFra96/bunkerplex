# BunkerPlex - "impronta" della versione del server. La usano Avvia.ps1 e Aggiorna.ps1.
#
# E' un riassunto dei file che decidono come gira il contenitore Docker: tutto
# server\ (codice, Dockerfile, pacchetti in requirements.txt) e docker-compose.yml.
# Avvia.ps1 la scrive nel contenitore (variabile BUNKERPLEX_BUILD); Aggiorna.ps1
# la confronta con quella attuale: se sono diverse il server gira con file vecchi
# e va ricostruito e riacceso.
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

function Get-Impronta($root) {
    $server = Join-Path $root 'server'
    $files = @()
    if (Test-Path -LiteralPath $server) {
        $files += Get-ChildItem -LiteralPath $server -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\__pycache__\\' -and $_.Extension -ne '.pyc' -and $_.Name -notlike '*.nuovo' }
    }
    $compose = Join-Path $root 'docker-compose.yml'
    if (Test-Path -LiteralPath $compose) { $files += Get-Item -LiteralPath $compose }
    $lines = foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        "${rel}:" + (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    }
    # Ordine "ordinale" (byte per byte), uguale a quello di Python in updater.py,
    # che calcola la stessa impronta da dentro il contenitore
    [string[]]$sorted = @($lines)
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $text = ($sorted -join "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
    } finally { $sha.Dispose() }
    return (-join ($bytes[0..7] | ForEach-Object { $_.ToString('x2') }))
}

# L'impronta con cui e' acceso il contenitore: '' se e' acceso senza (versione
# vecchia), $null se non e' acceso.
function Get-ImprontaServer {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $null }
    $running = (docker ps --filter 'name=^francoplex$' --format '{{.Names}}' 2>$null | Out-String).Trim()
    if (-not $running) { return $null }
    $vars = docker inspect francoplex --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
    foreach ($v in $vars) {
        if ("$v" -like 'BUNKERPLEX_BUILD=*') { return "$v".Substring(17).Trim() }
    }
    return ''
}
