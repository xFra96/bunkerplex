#!/bin/sh
# Compila la libreria Tailscale dell'app (Bpnet.xcframework) con gomobile, dallo
# stesso codice dell'app Android (android/tsnet). Serve un Mac con Xcode e Go:
# lo fa il giro workflows/app-ios.yml.
set -e
cd "$(dirname "$0")/../android/tsnet"
export PATH="$PATH:$(go env GOPATH)/bin"
V=$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install "golang.org/x/mobile/cmd/gomobile@$V"
go install "golang.org/x/mobile/cmd/gobind@$V"
gomobile init
rm -rf ../../ios/Bpnet.xcframework
gomobile bind -target=ios -iosversion 15.0 \
  -ldflags "-s -w -checklinkname=0" -trimpath -o ../../ios/Bpnet.xcframework .
ls ../../ios/Bpnet.xcframework
