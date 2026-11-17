#!/bin/bash
# Spegne BunkerPlex su Mac (doppio clic dal Finder). Usalo prima di staccare il disco.
cd "$(dirname "$0")/.." || exit 1
docker compose down
echo
echo "BunkerPlex e' spento. La libreria resta salvata nel catalogo."
read -r -p "Premi INVIO per chiudere questa finestra. " _
