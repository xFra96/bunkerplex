# BunkerPlex - porte nel firewall di Windows. La lancia "Installa" (con la
# richiesta di Windows "Consenti modifiche?"): non serve aprirla a mano.
#
# Apre in entrata:
#   - 32500 (TV, telefoni e PC di casa), solo dalla rete locale e da Tailscale
#     (100.64.0.0/10: i tuoi dispositivi, per esempio il telefono fuori casa);
#   - 32501 (amici e tuoi altri PC), che risponde solo a /api/share/;
#   - 32443 (https con certificato valido, per la PWA), come la 32500: solo dalla
#     rete locale e da Tailscale.
# Se in passato alla domanda di Windows su Docker si e' risposto "Annulla",
# Windows ha creato regole che bloccano Docker e prevalgono su ogni consenso:
# quelle si spengono (non si cancellano, si possono riaccendere).
#
#   -Check  non cambia niente: esce con 0 se e' tutto a posto, 1 se serve
#           sistemare (funziona anche senza permessi di amministratore).
#
# Solo caratteri ASCII in questo file (PowerShell 5 lo legge senza indicazioni).

param([switch]$Check)

$ErrorActionPreference = 'Continue'

$rules = @(
    @{ Name = 'BunkerPlex-32500'; Display = 'BunkerPlex (TV, telefoni e PC di casa)'; Port = 32500; Remote = @('LocalSubnet', '100.64.0.0/255.192.0.0') },
    @{ Name = 'BunkerPlex-32501'; Display = 'BunkerPlex (amici e tuoi altri PC)';     Port = 32501; Remote = 'Any' },
    @{ Name = 'BunkerPlex-32443'; Display = 'BunkerPlex (https per la PWA di casa)';  Port = 32443; Remote = @('LocalSubnet', '100.64.0.0/255.192.0.0') }
)

# Regole accese che bloccano in entrata i programmi di Docker Desktop
function Get-DockerBlocks {
    Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Program -match '\\docker' } |
        Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
}

function Test-Rules {
    foreach ($r in $rules) {
        $x = Get-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
        if (-not $x -or $x.Enabled -ne 'True' -or $x.Action -ne 'Allow') { return $false }
        # Da una versione precedente (32500 senza Tailscale): si rifa' la regola
        $have = @(($x | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue).RemoteAddress)
        if ($r.Port -eq 32500 -and -not ($have -match '^100.64.0.0/')) { return $false }
    }
    return -not @(Get-DockerBlocks)
}

if ($Check) {
    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { exit 0 }
    if (Test-Rules) { exit 0 } else { exit 1 }
}

$ok = $true
foreach ($r in $rules) {
    Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
    try {
        New-NetFirewallRule -Name $r.Name -DisplayName $r.Display -Group 'BunkerPlex' `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r.Port `
            -RemoteAddress $r.Remote -Profile Any -ErrorAction Stop | Out-Null
    } catch { $ok = $false }
}
foreach ($b in @(Get-DockerBlocks)) {
    try { $b | Disable-NetFirewallRule -ErrorAction Stop } catch { $ok = $false }
}
if ($ok) { exit 0 } else { exit 1 }
