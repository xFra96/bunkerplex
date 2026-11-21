#!/bin/sh
# Compila la libreria Tailscale dell'app (bpnet.aar) con gomobile.
# Serve: Go, l'SDK Android con l'NDK (ANDROID_HOME, ANDROID_NDK_HOME).
# Uso: sh tsnet/build.sh   (dalla cartella android; lo fanno il Dockerfile e GitHub)
set -e
cd "$(dirname "$0")"
export PATH="$PATH:$(go env GOPATH)/bin"
GOMOBILE=golang.org/x/mobile/cmd/gomobile@$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install "$GOMOBILE"
go install "golang.org/x/mobile/cmd/gobind@$(go list -m -f '{{.Version}}' golang.org/x/mobile)"
gomobile init
mkdir -p ../app/libs
# Telefoni e TV: ARM a 64 e 32 bit; x86_64 per l'emulatore
gomobile bind -target=android/arm64,android/arm,android/amd64 -androidapi 21 \
  -ldflags "-s -w -checklinkname=0" -trimpath -javapkg it.bunkerplex -o ../app/libs/bpnet.aar .
ls -l ../app/libs/bpnet.aar
