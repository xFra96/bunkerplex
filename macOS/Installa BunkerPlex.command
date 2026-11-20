#!/bin/bash
# Installa BunkerPlex su Mac (doppio clic dal Finder): e' l'unico file da lanciare,
# una volta sola. Fa quello che su Windows fa "Installa BunkerPlex.bat": accende
# Docker se e' spento e lo fa partire a ogni accesso, prepara il catalogo, collega
# i dischi (anche quelli esterni, pure quelli collegati dopo) in sola lettura e
# accende il server. Da li' in poi BunkerPlex lo tiene acceso Docker.
# Si puo' rilanciare quando si vuole: rimette a posto quello che manca.
cd "$(dirname "$0")/.." || exit 1

# Aperto dal Finder il Terminale non sempre trova il comando docker: con
# l'installazione "per l'utente" Docker Desktop lo mette in ~/.docker/bin, che
# non e' nel PATH. Si aggiungono a mano i posti dove puo' stare.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin"
export PATH

# Lo zip scaricato da Internet marca ogni file come "da Internet" (quarantena) e
# macOS blocca il doppio clic. Dopo il primo via libera si toglie a tutta la
# cartella, e questo file torna eseguibile se un aggiornamento lo ha rimesso
# senza permessi.
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x macOS/*.command 2>/dev/null

fine() {
  echo
  read -r -p "Premi INVIO per chiudere questa finestra. " _
  exit "${1:-0}"
}

if ! command -v docker >/dev/null 2>&1; then
  if [ -d /Applications/Docker.app ] || [ -d "$HOME/Applications/Docker.app" ]; then
    echo "Docker Desktop c'e' ma non e' ancora pronto: aprilo una volta dalla"
    echo "cartella Applicazioni, accetta le condizioni, aspetta che dica"
    echo "\"Engine running\" e poi rilancia questo file."
    fine 1
  fi
  echo "Su questo Mac manca Docker Desktop."
  echo "Scaricalo da https://www.docker.com/products/docker-desktop/ , installalo,"
  echo "aprilo una volta (accetta le condizioni) e poi rilancia questo file."
  fine 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Accendo Docker Desktop: ci vuole circa un minuto..."
  open -a Docker 2>/dev/null
  for _ in $(seq 1 90); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker non e' partito. Aprilo a mano (cartella Applicazioni) e rilancia questo file."
    fine 1
  fi
fi

# Il catalogo sta nella cartella "data" qui accanto. Il segnaposto dice al server
# che e' davvero la cartella del catalogo e non una cartella vuota creata da Docker.
mkdir -p data apk
if ! printf 'Catalogo di BunkerPlex: non cancellare questo file.\n' > data/.bunkerplex; then
  echo "Non riesco a scrivere nella cartella data: il disco e' protetto o pieno?"
  fine 1
fi

# Docker Desktop parte da solo a ogni accesso al Mac, e con lui BunkerPlex
# (restart: unless-stopped). Si aggiunge agli elementi di login se non c'e' gia'.
docker_app=""
for a in /Applications/Docker.app "$HOME/Applications/Docker.app"; do
  [ -d "$a" ] && docker_app="$a" && break
done
if [ -n "$docker_app" ]; then
  if ! osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q Docker; then
    osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$docker_app\", hidden:true}" >/dev/null 2>&1 \
      || echo "Non riesco a far partire Docker da solo: in Docker Desktop, Settings - General, attiva \"Start Docker Desktop when you sign in\"."
  fi
fi

# Dischi: /Volumes (disco interno e dischi esterni) e /Users, in sola lettura.
# Si collegano le cartelle intere: un disco esterno collegato dopo compare da solo
# dentro /Volumes, senza rilanciare niente.
{
  echo '# Creato da "Installa BunkerPlex.command": non modificarlo a mano.'
  echo 'services:'
  echo '  bunkerplex:'
  echo '    volumes:'
  for d in /Volumes /Users; do
    if [ -d "$d" ]; then
      echo '      - type: bind'
      echo "        source: \"$d\""
      echo "        target: /host$d"
      echo '        read_only: true'
    fi
  done
} > docker-compose.override.yml

# Indirizzo del Mac in casa: dentro Docker il server non lo vede (serve al QR dell'app)
ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
export BUNKERPLEX_LAN_IP="$ip"

# Il contenitore delle versioni precedenti si chiamava francoplex: terrebbe occupata la porta
docker rm -f francoplex >/dev/null 2>&1

echo
echo "Avvio BunkerPlex... la prima volta su un Mac ci vuole qualche minuto."
if ! docker compose up -d --build; then
  echo
  echo "Il server non e' partito: leggi il messaggio qui sopra."
  echo "La prima volta serve Internet. Se parla della porta 32500, un altro programma la sta usando."
  fine 1
fi

echo
echo "BunkerPlex e' installato e acceso."
echo "  Da questo Mac:        http://localhost:32500"
[ -n "$ip" ] && echo "  Da TV, telefono e PC: http://$ip:32500"
echo
echo "Da adesso BunkerPlex lo tiene acceso Docker, anche dopo un riavvio del Mac:"
echo "non serve rilanciare niente. Per spegnerlo: Docker Desktop, Containers, Stop."
echo
echo "Se un disco esterno non si vede nella scelta delle cartelle: Docker Desktop,"
echo "Settings - Resources - File sharing, aggiungi /Volumes e rilancia questo file."
open "http://localhost:32500" 2>/dev/null
fine 0
