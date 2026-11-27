#!/bin/bash
# Installa BunkerPlex su una TV Samsung in Modalita' sviluppatore.
# Gira dentro l'immagine Docker con Tizen Studio di install-jellyfin-tizen (Georift):
# di quella si usano solo «sdb» e «tizen», l'app e' la nostra.
#
#   installa.sh <IP della TV> [password del certificato Samsung]
#
# Con la password: rifirma l'app col certificato Samsung della TV (author.p12 e
# distributor.p12 in /certificates), che le TV dal 2024 circa pretendono.
# L'app arriva dalla release «samsung-tv» (o da /bp/BunkerPlex.wgt, se c'e').
set -e
IP="$1"
PW="$2"
URL="${BP_WGT_URL:-https://github.com/xFra96/bunkerplex/releases/download/samsung-tv/BunkerPlex.wgt}"
if [ -z "$IP" ]; then
  echo "Uso: installa.sh <IP della TV> [password del certificato Samsung]"
  exit 1
fi

work="$(mktemp -d)"
cd "$work"
if [ -f /bp/BunkerPlex.wgt ]; then
  echo "Uso BunkerPlex.wgt della cartella tizen."
  cp /bp/BunkerPlex.wgt .
else
  echo "Scarico BunkerPlex.wgt..."
  curl -fsSL -o BunkerPlex.wgt "$URL" 2>/dev/null || wget -q -O BunkerPlex.wgt "$URL"
fi

echo "Mi collego alla TV $IP..."
sdb connect "$IP"
TV="$(sdb devices | grep -F "$IP" | awk '{print $3}' | head -1)"
if [ -z "$TV" ]; then
  echo
  echo "La TV non risponde. Controlla che:"
  echo " - la Modalita' sviluppatore sia accesa (App, poi 1 2 3 4 5 col telecomando)"
  echo " - come «IP del PC host» ci sia l'indirizzo di QUESTO PC, e la TV sia stata riavviata"
  echo " - TV e PC siano sulla stessa rete"
  exit 2
fi
echo "TV trovata: $TV"

if [ -n "$PW" ]; then
  if [ ! -f /certificates/author.p12 ] || [ ! -f /certificates/distributor.p12 ]; then
    echo "Mancano author.p12 e distributor.p12 nella cartella tizen/certificati."
    exit 3
  fi
  echo "Firmo l'app col certificato Samsung della TV..."
  tizen security-profiles add -n BPSamsung -a /certificates/author.p12 -p "$PW" \
    -d /certificates/distributor.p12 -dp "$PW" > /dev/null
  prof="$(find / -name profiles.xml -path '*profile*' 2>/dev/null | head -1)"
  # le password in chiaro nel profilo: cosi' «tizen package» non le chiede
  sed -i "s|/certificates/author.pwd|$PW|g; s|/certificates/distributor.pwd|$PW|g" "$prof"
  tizen package -t wgt -s BPSamsung -- "$work/BunkerPlex.wgt"
fi

echo "Installo..."
out="$(tizen install -n BunkerPlex.wgt -t "$TV" 2>&1)" || true
echo "$out"
sdb disconnect "$IP" > /dev/null 2>&1 || true
if echo "$out" | grep -q "Installed the package"; then
  echo
  echo "Fatto: BunkerPlex e' in App sulla TV. Aprila e collegala dal telefono col codice."
  exit 0
fi
echo
if echo "$out" | grep -q "Author certificate not match"; then
  echo "Sulla TV c'e' gia' BunkerPlex firmata in un altro modo: disinstallala dalla TV e riprova."
elif echo "$out" | grep -qi "certificate"; then
  echo "La TV vuole un certificato Samsung fatto per lei (TV dal 2024 circa): vedi tizen/LEGGIMI.md."
fi
exit 4
