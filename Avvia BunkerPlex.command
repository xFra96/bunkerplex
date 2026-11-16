#!/bin/bash
# Avvia BunkerPlex su Mac (doppio clic dal Finder). Fa quello che su Windows fa
# "Avvia BunkerPlex.bat": accende Docker se e' spento, prepara il catalogo,
# collega i dischi (anche quelli esterni) in sola lettura e accende il server.
cd "$(dirname "$0")" || exit 1

fine() {
  echo
  read -r -p "Premi INVIO per chiudere questa finestra. " _
  exit "${1:-0}"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Su questo Mac manca Docker Desktop."
  echo "Scaricalo da https://www.docker.com/products/docker-desktop/ , installalo,"
  echo "aprilo una volta e poi rilancia questo file."
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
if ! printf 'Catalogo di BunkerPlex: non cancellare questo file.\n' > data/.francoplex; then
  echo "Non riesco a scrivere nella cartella data: il disco e' protetto o pieno?"
  fine 1
fi

# Dischi: /Volumes (disco interno e dischi esterni) e /Users, in sola lettura.
{
  echo '# Creato da "Avvia BunkerPlex.command" a ogni avvio: non modificarlo a mano.'
  echo 'services:'
  echo '  francoplex:'
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

echo
echo "Avvio BunkerPlex... la prima volta su un Mac ci vuole qualche minuto."
if ! docker compose up -d --build; then
  echo
  echo "Il server non e' partito: leggi il messaggio qui sopra."
  echo "La prima volta serve Internet. Se parla della porta 32500, un altro programma la sta usando."
  fine 1
fi

ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "BunkerPlex e' acceso."
echo "  Da questo Mac:        http://localhost:32500"
[ -n "$ip" ] && echo "  Da TV, telefono e PC: http://$ip:32500"
echo
echo "Se un disco esterno non si vede nella scelta delle cartelle: Docker Desktop,"
echo "Settings - Resources - File sharing, aggiungi /Volumes e rilancia questo file."
open "http://localhost:32500" 2>/dev/null
fine 0
